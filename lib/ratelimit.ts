/**
 * Spend guards for the public demo.
 *
 * Two independent ceilings:
 *   - a per-visitor daily query cap, so one person cannot exhaust the budget
 *   - a hard monthly token ceiling across everyone, so an unattended link
 *     cannot run up an unbounded bill
 *
 * Both are counters in Postgres. The daily cap degrades gracefully — the UI is
 * told how many queries remain and says so before the visitor hits the wall,
 * rather than presenting a working text box that suddenly errors.
 */
import { createHash } from 'node:crypto';
import { query, queryOne } from './db';

const DEFAULT_DAILY_CAP = 20;
const DEFAULT_MONTHLY_TOKEN_CAP = 2_000_000;

/**
 * MCP calls get their own, much larger budget. They cost no model tokens — an
 * MCP client brings its own — so the only thing being protected is the
 * database, and an evaluator poking at the tool layer from Claude Code should
 * never bump into a wall the chat's 20-question cap would impose after a
 * minute of exploring.
 */
const DEFAULT_MCP_DAILY_CAP = 400;

export const dailyCap = () =>
    Number(process.env.DEMO_DAILY_QUERY_CAP ?? DEFAULT_DAILY_CAP);

export const monthlyTokenCap = () =>
    Number(process.env.DEMO_MONTHLY_TOKEN_CAP ?? DEFAULT_MONTHLY_TOKEN_CAP);

export const mcpDailyCap = () =>
    Number(process.env.DEMO_MCP_DAILY_CAP ?? DEFAULT_MCP_DAILY_CAP);

/**
 * Salted hash of the caller's IP. Enough to count against, not enough to
 * identify anyone — and no raw address is ever written to the database.
 */
export function visitorHash(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for') ?? '';
    const ip = forwarded.split(',')[0].trim()
        || request.headers.get('x-real-ip')
        || 'unknown';
    const salt = process.env.RATE_LIMIT_SALT ?? 'foundry-ops-demo';
    return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

export interface Quota {
    allowed: boolean;
    remaining: number;
    limit: number;
    reason?: string;
}

/**
 * Reserve one query for this visitor.
 *
 * The increment and the check happen in a single statement so two concurrent
 * requests cannot both read "19 used" and both proceed. The row's own post-
 * increment value decides.
 */
export async function reserveQuery(request: Request): Promise<Quota> {
    const limit = dailyCap();
    const hash = visitorHash(request);

    // Monthly ceiling first — it protects the account, so it wins.
    const month = await queryOne<{ input_tokens: string; output_tokens: string }>(
        `SELECT input_tokens, output_tokens FROM app.usage_month
         WHERE month = to_char(now(), 'YYYY-MM')`,
    );
    const used = Number(month?.input_tokens ?? 0) + Number(month?.output_tokens ?? 0);
    if (used >= monthlyTokenCap()) {
        return {
            allowed: false,
            remaining: 0,
            limit,
            reason:
                'This demo has reached its monthly token budget. The dashboard and schedule ' +
                'still work — they do not call the model. Clone the repo to run chat with your own key.',
        };
    }

    const row = await queryOne<{ queries: number }>(
        `INSERT INTO app.usage_day (day, ip_hash, queries)
         VALUES (CURRENT_DATE, $1, 1)
         ON CONFLICT (day, ip_hash)
         DO UPDATE SET queries = app.usage_day.queries + 1
         RETURNING queries`,
        [hash],
    );

    const count = row?.queries ?? 1;
    if (count > limit) {
        return {
            allowed: false,
            remaining: 0,
            limit,
            reason:
                `You have used today's ${limit} questions on this demo. The limit resets at ` +
                `midnight UTC — the dashboard and schedule keep working in the meantime.`,
        };
    }

    return { allowed: true, remaining: Math.max(0, limit - count), limit };
}

/**
 * Reserve one MCP request for this visitor.
 *
 * Counted in the same table but under an `mcp:` prefixed key, so MCP traffic
 * and chat questions are metered separately. Sharing one counter would let a
 * few minutes of tool exploration silently consume someone's chat quota and
 * produce a 429 in the web UI they never earned — different resources, and the
 * prefix keeps them that way without a migration.
 *
 * Fails open: the monthly *token* ceiling does not apply here because these
 * tools call no model, and a counter outage should not take the endpoint down.
 */
export async function reserveMcpCall(request: Request): Promise<Quota> {
    const limit = mcpDailyCap();
    try {
        const row = await queryOne<{ queries: number }>(
            `INSERT INTO app.usage_day (day, ip_hash, queries)
             VALUES (CURRENT_DATE, $1, 1)
             ON CONFLICT (day, ip_hash)
             DO UPDATE SET queries = app.usage_day.queries + 1
             RETURNING queries`,
            [`mcp:${visitorHash(request)}`],
        );

        const count = row?.queries ?? 1;
        if (count > limit) {
            return {
                allowed: false,
                remaining: 0,
                limit,
                reason:
                    `This demo allows ${limit} MCP requests per client per day, and you have ` +
                    `used them. The limit resets at midnight UTC. Clone the repo and run ` +
                    `\`npm run mcp\` against your own database for an uncapped copy.`,
            };
        }

        return { allowed: true, remaining: Math.max(0, limit - count), limit };
    } catch {
        return { allowed: true, remaining: limit, limit };
    }
}

/** Record what a completed turn actually cost. Never blocks the response. */
export async function recordUsage(input: number, output: number): Promise<void> {
    try {
        await query(
            `INSERT INTO app.usage_month (month, input_tokens, output_tokens, queries)
             VALUES (to_char(now(), 'YYYY-MM'), $1, $2, 1)
             ON CONFLICT (month) DO UPDATE SET
                 input_tokens  = app.usage_month.input_tokens  + $1,
                 output_tokens = app.usage_month.output_tokens + $2,
                 queries       = app.usage_month.queries + 1`,
            [input, output],
        );
    } catch {
        // Accounting is not worth failing a served answer over.
    }
}

/** Read-only quota check, for showing remaining questions before asking. */
export async function peekQuota(request: Request): Promise<Quota> {
    const limit = dailyCap();
    try {
        const row = await queryOne<{ queries: number }>(
            `SELECT queries FROM app.usage_day WHERE day = CURRENT_DATE AND ip_hash = $1`,
            [visitorHash(request)],
        );
        const used = row?.queries ?? 0;
        return { allowed: used < limit, remaining: Math.max(0, limit - used), limit };
    } catch {
        return { allowed: true, remaining: limit, limit };
    }
}
