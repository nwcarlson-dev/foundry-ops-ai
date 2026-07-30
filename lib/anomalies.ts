/**
 * Deterministic anomaly detection.
 *
 * Everything here is SQL and arithmetic. No model is involved in deciding what
 * is wrong, how bad it is, or what the numbers are — the LLM's only job on the
 * dashboard is to write one sentence of narrative over findings that were
 * already computed. That division is deliberate and stated in the README: it is
 * the difference between a tool a plant can audit and one it has to trust.
 *
 * Each finding carries the question that investigates it, so every card can
 * hand off to the chat surface with the context already loaded.
 */
import { query } from './db';
import { DATASET_TODAY } from './dataset';
import type { SourceSystem } from './tools/types';

export type Severity = 'critical' | 'warning' | 'watch';

export interface Finding {
    id: string;
    severity: Severity;
    title: string;
    /** Deterministic, numeric, no interpretation. */
    detail: string;
    sources: SourceSystem[];
    /** Prefills the chat surface. */
    ask: string;
    /** Filled in by the narrative pass, if it runs. */
    narrative?: string;
}

export interface ScrapPoint { week: string; reason_code: string; qty: number }
export interface LoadRow {
    wc_code: string; dept: string; committed_hrs: number;
    effective_hrs: number; utilization_pct: number | null;
}
export interface MatchRow { source_pair: string; matched: number; total: number; match_pct: number }
export interface RiskRow {
    job_num: string; part_num: string; customer_code: string; req_due_date: string;
    days_to_due: number; verdict: string; bottleneck_wc: string; why: string;
}

export interface Dashboard {
    as_of: string;
    findings: Finding[];
    scrap_series: ScrapPoint[];
    scrap_reasons: string[];
    load: LoadRow[];
    reconciliation: MatchRow[];
    at_risk: RiskRow[];
    counts: { open_jobs: number; at_risk: number; unmatched: number };
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Scrap by reason code: mean and standard deviation over a baseline window,
 * compared against the recent window. Reported as a z-score so a small absolute
 * rise on a normally-stable code outranks noise on a volatile one.
 */
async function detectScrapSpikes(): Promise<Finding[]> {
    const rows = await query(`
        WITH weekly AS (
            SELECT sd.reason_code,
                   date_trunc('week', sd.logged_at)::date AS week,
                   SUM(sd.scrap_qty)::numeric AS qty
            FROM epicor.scrap_dtl sd
            WHERE sd.logged_at >= $1::date - INTERVAL '26 weeks'
              AND sd.logged_at <= $1::date
            GROUP BY 1, 2
        ),
        split AS (
            SELECT reason_code, qty,
                   (week >= $1::date - INTERVAL '4 weeks') AS is_recent
            FROM weekly
        ),
        stats AS (
            SELECT reason_code,
                   AVG(qty) FILTER (WHERE NOT is_recent)    AS base_mean,
                   STDDEV_SAMP(qty) FILTER (WHERE NOT is_recent) AS base_sd,
                   AVG(qty) FILTER (WHERE is_recent)        AS recent_mean,
                   COUNT(*) FILTER (WHERE NOT is_recent)::int AS base_weeks
            FROM split GROUP BY 1
        )
        SELECT s.reason_code, sr.description, sr.category,
               ROUND(s.base_mean, 1)   AS base_mean,
               ROUND(s.recent_mean, 1) AS recent_mean,
               ROUND(((s.recent_mean - s.base_mean)
                      / NULLIF(s.base_sd, 0))::numeric, 1) AS z
        FROM stats s
        JOIN epicor.scrap_reason sr ON sr.reason_code = s.reason_code
        WHERE s.base_weeks >= 8
          AND s.base_sd > 0
          AND s.recent_mean > s.base_mean
          AND ((s.recent_mean - s.base_mean) / s.base_sd) >= 2
        ORDER BY z DESC`,
        [DATASET_TODAY],
    );

    return (rows as Array<Record<string, unknown>>).map((r) => {
        const z = num(r.z);
        const code = String(r.reason_code);
        const melt = String(r.category) === 'MELT';
        return {
            id: `scrap-${code}`,
            severity: (z >= 4 ? 'critical' : z >= 3 ? 'warning' : 'watch') as Severity,
            title: `${r.description} scrap rising`,
            detail:
                `${code} averaged ${num(r.recent_mean)} pcs/week over the last 4 weeks against a ` +
                `${num(r.base_mean)} pcs/week baseline — ${z} standard deviations above normal.`,
            sources: ['epicor'] as SourceSystem[],
            ask: melt
                ? `${r.description} scrap is up. Which parts and work centres, and do the heats behind them explain it?`
                : `${r.description} scrap is up. What is driving it?`,
        };
    });
}

/**
 * Unplanned downtime per work centre, compared as a RATE. Absolute hours over
 * a short recent window will always look small next to eighteen months, so the
 * only comparison that means anything is hours per day.
 */
async function detectDowntimeSpikes(): Promise<Finding[]> {
    const rows = await query(`
        WITH scoped AS (
            SELECT wt.wc_code,
                   de.started_at,
                   EXTRACT(EPOCH FROM (de.ended_at - de.started_at)) / 3600 AS hrs
            FROM ignition.downtime_event de
            JOIN xref.wc_tag wt ON de.tag_path LIKE wt.tag_prefix || '/%'
            WHERE de.ended_at IS NOT NULL
              AND de.reason_text !~* '(pm|preventive|scheduled|die change|tooling)'
        )
        SELECT s.wc_code, wc.description,
               ROUND((SUM(s.hrs) FILTER (WHERE s.started_at >= $1::date - INTERVAL '21 days')
                      / 21.0)::numeric, 2) AS recent_rate,
               ROUND((SUM(s.hrs) FILTER (WHERE s.started_at <  $1::date - INTERVAL '21 days')
                      / 525.0)::numeric, 2) AS base_rate,
               ROUND(SUM(s.hrs) FILTER (WHERE s.started_at >= $1::date - INTERVAL '21 days')::numeric, 1)
                      AS recent_hrs,
               COUNT(*) FILTER (WHERE s.started_at >= $1::date - INTERVAL '21 days')::int AS events
        FROM scoped s
        JOIN epicor.work_center wc ON wc.wc_code = s.wc_code
        GROUP BY 1, 2
        HAVING SUM(s.hrs) FILTER (WHERE s.started_at >= $1::date - INTERVAL '21 days') > 0
        ORDER BY recent_rate DESC`,
        [DATASET_TODAY],
    );

    return (rows as Array<Record<string, unknown>>)
        .filter((r) => num(r.recent_rate) > Math.max(num(r.base_rate) * 3, 0.5))
        .map((r) => {
            const ratio = num(r.base_rate) > 0 ? num(r.recent_rate) / num(r.base_rate) : 0;
            return {
                id: `downtime-${r.wc_code}`,
                severity: (ratio >= 8 ? 'critical' : 'warning') as Severity,
                title: `Unplanned downtime on ${r.wc_code}`,
                detail:
                    `${num(r.recent_hrs)} hrs across ${r.events} unplanned events in the last 21 days ` +
                    `(${num(r.recent_rate)} hrs/day against a ${num(r.base_rate)} hrs/day baseline` +
                    `${ratio ? `, ${Math.round(ratio)}x` : ''}).`,
                sources: ['ignition', 'xref'] as SourceSystem[],
                ask: `${r.wc_code} has been down a lot recently. What happened, and which jobs does it put at risk?`,
            };
        });
}

/**
 * Labour efficiency drift per work centre and shift. Reported only where the
 * recent window is meaningfully worse than the same work centre's own history,
 * so a consistently-slow operation does not fire every day.
 */
async function detectEfficiencyDrift(): Promise<Finding[]> {
    const rows = await query(`
        WITH op AS (
            SELECT jo.wc_code, MIN(ld.shift) AS shift,
                   jo.est_setup_hrs + jo.est_prod_hrs AS est,
                   jo.act_setup_hrs + jo.act_prod_hrs AS act,
                   MIN(ld.clock_in) AS started
            FROM epicor.job_oper jo
            JOIN epicor.labor_dtl ld
                   ON ld.job_num = jo.job_num AND ld.oper_seq = jo.oper_seq
            WHERE jo.est_prod_hrs > 0 AND jo.act_prod_hrs > 0
            GROUP BY jo.job_num, jo.oper_seq, jo.wc_code,
                     jo.est_setup_hrs, jo.est_prod_hrs, jo.act_setup_hrs, jo.act_prod_hrs
        )
        SELECT wc_code, shift,
               ROUND((SUM(act) FILTER (WHERE started >= $1::date - INTERVAL '60 days')
                      / NULLIF(SUM(est) FILTER (WHERE started >= $1::date - INTERVAL '60 days'), 0))::numeric, 3)
                      AS recent_ratio,
               ROUND((SUM(act) FILTER (WHERE started <  $1::date - INTERVAL '60 days')
                      / NULLIF(SUM(est) FILTER (WHERE started <  $1::date - INTERVAL '60 days'), 0))::numeric, 3)
                      AS base_ratio,
               COUNT(*) FILTER (WHERE started >= $1::date - INTERVAL '60 days')::int AS recent_ops
        FROM op GROUP BY 1, 2
        HAVING COUNT(*) FILTER (WHERE started >= $1::date - INTERVAL '60 days') >= 5`,
        [DATASET_TODAY],
    );

    return (rows as Array<Record<string, unknown>>)
        .filter((r) => num(r.recent_ratio) > 1.08
                    && num(r.recent_ratio) - num(r.base_ratio) > 0.08)
        .map((r) => {
            const over = (num(r.recent_ratio) - 1) * 100;
            return {
                id: `eff-${r.wc_code}-s${r.shift}`,
                severity: (over >= 20 ? 'warning' : 'watch') as Severity,
                title: `Shift ${r.shift} running over standard on ${r.wc_code}`,
                detail:
                    `${r1(over)}% over standard across ${r.recent_ops} operations in the last 60 days, ` +
                    `against ${r1((num(r.base_ratio) - 1) * 100)}% historically.`,
                sources: ['epicor'] as SourceSystem[],
                ask: `Shift ${r.shift} on ${r.wc_code} is running over standard. Is that the standard or the crew?`,
            };
        });
}

/**
 * Standards that are simply wrong.
 *
 * The drift detectors above look for CHANGE, so a standard that has been wrong
 * for years is invisible to them — there is nothing to trend. This one looks for
 * a persistent condition instead: an operation that runs over standard
 * consistently, across many jobs AND many operators. That last clause is what
 * separates a bad number from a bad crew, and it is the whole reason the finding
 * is actionable — you fix it in the router, not on the floor.
 */
async function detectWrongStandards(): Promise<Finding[]> {
    const rows = await query(`
        WITH op AS (
            SELECT jh.part_num, jo.oper_seq, jo.wc_code,
                   jo.est_setup_hrs + jo.est_prod_hrs AS est,
                   jo.act_setup_hrs + jo.act_prod_hrs AS act,
                   COUNT(DISTINCT ld.employee_num) AS operators
            FROM epicor.job_oper jo
            JOIN epicor.job_head jh ON jh.job_num = jo.job_num
            JOIN epicor.labor_dtl ld
                   ON ld.job_num = jo.job_num AND ld.oper_seq = jo.oper_seq
            WHERE jo.est_prod_hrs > 0 AND jo.act_prod_hrs > 0
              AND ld.clock_in >= $1::date - INTERVAL '270 days'
            GROUP BY jh.part_num, jo.oper_seq, jo.wc_code,
                     jo.est_setup_hrs, jo.est_prod_hrs, jo.act_setup_hrs, jo.act_prod_hrs
        )
        -- Grouped by part and operation only. A standard belongs to the routing
        -- step, not to whichever interchangeable cell happened to run it, so
        -- including wc_code here splits one finding into several near-duplicate
        -- cards and buries the signal in its own noise.
        SELECT part_num, oper_seq,
               string_agg(DISTINCT wc_code, ', ' ORDER BY wc_code) AS work_centres,
               COUNT(*)::int AS jobs,
               SUM(operators)::int AS operator_touches,
               ROUND((SUM(act) / NULLIF(SUM(est), 0))::numeric, 3) AS ratio,
               -- Share of individual runs over standard. A wrong standard is
               -- missed nearly every time, not on average.
               ROUND((COUNT(*) FILTER (WHERE act > est * 1.1)::numeric
                      / COUNT(*))::numeric, 2) AS share_over
        FROM op
        GROUP BY 1, 2
        HAVING COUNT(*) >= 8
           AND (SUM(act) / NULLIF(SUM(est), 0)) > 1.15
           AND (COUNT(*) FILTER (WHERE act > est * 1.1)::numeric / COUNT(*)) > 0.7
        ORDER BY ratio DESC LIMIT 2`,
        [DATASET_TODAY],
    );

    return (rows as Array<Record<string, unknown>>).map((r) => {
        const over = (num(r.ratio) - 1) * 100;
        return {
            id: `standard-${r.part_num}-${r.oper_seq}`,
            severity: (over >= 20 ? 'warning' : 'watch') as Severity,
            title: `Standard looks wrong on ${r.part_num} op ${r.oper_seq}`,
            detail:
                `Runs ${r1(over)}% over standard across ${r.jobs} jobs at ${r.work_centres}, ` +
                `missed on ${Math.round(num(r.share_over) * 100)}% of runs and spread across ` +
                `${r.operator_touches} operator assignments — not one crew.`,
            sources: ['epicor'] as SourceSystem[],
            ask: `${r.part_num} operation ${r.oper_seq} runs over standard. Is that the standard or the crew?`,
        };
    });
}

/** Reconciliation gaps, so a blind spot is visible rather than implied. */
async function detectReconciliationGaps(): Promise<Finding[]> {
    const rows = await query(
        `SELECT source_pair, COUNT(*)::int AS n FROM xref.unmatched GROUP BY 1 ORDER BY n DESC`,
    );
    const total = (rows as Array<Record<string, unknown>>).reduce((s, r) => s + num(r.n), 0);
    if (total === 0) return [];

    const worst = rows[0] as Record<string, unknown>;
    return [{
        id: 'recon-gaps',
        severity: 'watch' as Severity,
        title: `${total} records do not reconcile across systems`,
        detail:
            `Largest gap is ${worst.source_pair} with ${num(worst.n)} unmatched. ` +
            `Any answer touching those records is incomplete.`,
        sources: ['xref', 'epicor', 'thrive', 'ignition', 'monday'] as SourceSystem[],
        ask: 'How well do the four source systems reconcile, and what specifically does not match?',
    }];
}

// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, watch: 2 };

export async function getDashboard(): Promise<Dashboard> {
    const [scrap, downtime, efficiency, standards, recon] = await Promise.all([
        detectScrapSpikes(),
        detectDowntimeSpikes(),
        detectEfficiencyDrift(),
        detectWrongStandards(),
        detectReconciliationGaps(),
    ]);

    const findings = [...scrap, ...downtime, ...efficiency, ...standards, ...recon]
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
        .slice(0, 8);

    // --- chart data --------------------------------------------------------

    // Weekly scrap for the four codes with the most volume, so the trend chart
    // has a fixed, non-cycling series set.
    const topReasons = await query(
        `SELECT sd.reason_code FROM epicor.scrap_dtl sd
         WHERE sd.logged_at >= $1::date - INTERVAL '16 weeks'
         GROUP BY 1 ORDER BY SUM(sd.scrap_qty) DESC LIMIT 4`,
        [DATASET_TODAY],
    );
    const reasons = (topReasons as Array<{ reason_code: string }>).map((r) => r.reason_code);

    const scrapSeries = reasons.length === 0 ? [] : await query(
        `SELECT date_trunc('week', logged_at)::date::text AS week,
                reason_code, SUM(scrap_qty)::int AS qty
         FROM epicor.scrap_dtl
         WHERE logged_at >= $1::date - INTERVAL '16 weeks'
           AND logged_at <= $1::date
           AND reason_code = ANY($2)
         GROUP BY 1, 2 ORDER BY 1`,
        [DATASET_TODAY, reasons],
    );

    const load = await query(
        `WITH committed AS (
             SELECT jo.wc_code, SUM(jo.est_setup_hrs + jo.est_prod_hrs) AS hrs
             FROM epicor.job_oper jo
             JOIN epicor.job_head jh ON jh.job_num = jo.job_num
             WHERE jh.job_closed = FALSE AND jo.act_prod_hrs = 0
             GROUP BY 1
         ),
         downtime AS (
             SELECT wt.wc_code,
                    SUM(EXTRACT(EPOCH FROM (de.ended_at - de.started_at)) / 3600) AS down
             FROM ignition.downtime_event de
             JOIN xref.wc_tag wt ON de.tag_path LIKE wt.tag_prefix || '/%'
             WHERE de.started_at >= $1::date - INTERVAL '21 days'
               AND de.ended_at IS NOT NULL
               AND de.reason_text !~* '(pm|preventive|scheduled|die change|tooling)'
             GROUP BY 1
         )
         SELECT wc.wc_code, wc.dept,
                ROUND(COALESCE(c.hrs, 0)::numeric, 1) AS committed_hrs,
                ROUND(GREATEST(0, wc.shifts_per_day * wc.hrs_per_shift * wc.resources * 5
                      - COALESCE(d.down, 0) / 3)::numeric, 1) AS effective_hrs
         FROM epicor.work_center wc
         LEFT JOIN committed c ON c.wc_code = wc.wc_code
         LEFT JOIN downtime  d ON d.wc_code = wc.wc_code
         WHERE COALESCE(c.hrs, 0) > 0
         ORDER BY COALESCE(c.hrs, 0) DESC`,
        [DATASET_TODAY],
    );

    const reconciliation = await query(
        `SELECT source_pair, matched, total,
                ROUND(100.0 * matched / NULLIF(total, 0), 1) AS match_pct
         FROM xref.match_rate ORDER BY match_pct`,
    );

    const atRisk = await query(
        `WITH remaining AS (
             SELECT jo.job_num, jo.wc_code, SUM(jo.est_setup_hrs + jo.est_prod_hrs) AS rem
             FROM epicor.job_oper jo
             JOIN epicor.job_head jh ON jh.job_num = jo.job_num
             WHERE jh.job_closed = FALSE AND jo.act_prod_hrs = 0
             GROUP BY 1, 2
         )
         SELECT jh.job_num, jh.part_num, p.customer_code,
                jh.req_due_date::text AS req_due_date,
                (jh.req_due_date - $1::date) AS days_to_due,
                (array_agg(rm.wc_code ORDER BY rm.rem DESC))[1] AS bottleneck_wc,
                ROUND(SUM(rm.rem)::numeric, 1) AS remaining_hrs
         FROM epicor.job_head jh
         JOIN epicor.part p ON p.part_num = jh.part_num
         JOIN remaining rm ON rm.job_num = jh.job_num
         WHERE jh.job_closed = FALSE
         GROUP BY jh.job_num, jh.part_num, p.customer_code, jh.req_due_date
         ORDER BY days_to_due LIMIT 12`,
        [DATASET_TODAY],
    );

    const counts = await query(
        `SELECT (SELECT COUNT(*)::int FROM epicor.job_head WHERE job_closed = FALSE) AS open_jobs,
                (SELECT COUNT(*)::int FROM xref.unmatched) AS unmatched`,
    );

    return {
        as_of: DATASET_TODAY,
        findings,
        scrap_series: (scrapSeries as Array<Record<string, unknown>>).map((r) => ({
            week: String(r.week), reason_code: String(r.reason_code), qty: num(r.qty),
        })),
        scrap_reasons: reasons,
        load: (load as Array<Record<string, unknown>>).map((r) => ({
            wc_code: String(r.wc_code), dept: String(r.dept),
            committed_hrs: num(r.committed_hrs), effective_hrs: num(r.effective_hrs),
            utilization_pct: num(r.effective_hrs) > 0
                ? r1((num(r.committed_hrs) / num(r.effective_hrs)) * 100) : null,
        })),
        reconciliation: reconciliation as unknown as MatchRow[],
        at_risk: (atRisk as Array<Record<string, unknown>>).map((r) => ({
            job_num: String(r.job_num), part_num: String(r.part_num),
            customer_code: String(r.customer_code), req_due_date: String(r.req_due_date),
            days_to_due: num(r.days_to_due), verdict: '',
            bottleneck_wc: String(r.bottleneck_wc),
            why: `${num(r.remaining_hrs)} hrs remaining at ${r.bottleneck_wc}`,
        })),
        counts: {
            open_jobs: num((counts[0] as Record<string, unknown>)?.open_jobs),
            at_risk: findings.filter((f) => f.severity !== 'watch').length,
            unmatched: num((counts[0] as Record<string, unknown>)?.unmatched),
        },
    };
}
