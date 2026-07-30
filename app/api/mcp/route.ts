/**
 * The foundry tool layer as a hosted MCP server.
 *
 * The stdio server in mcp/server.ts can only be run by someone holding this
 * project's DATABASE_URL — which is nobody but its author. That made the MCP
 * work unrunnable for the people most likely to want to see it. This exposes
 * the identical registry over streamable HTTP, so any MCP client can be pointed
 * at the live deployment and start asking:
 *
 *   claude mcp add --transport http foundry-ops \
 *     https://foundry-ops-ai.vercel.app/api/mcp
 *
 * Both transports call registerFoundryTools (lib/mcp.ts). Neither knows
 * anything the other does not.
 *
 * ON EXPOSING THIS PUBLICLY: every tool is read-only and allowlisted by name
 * through TOOLS_BY_NAME, its input is parsed by a Zod schema before a query
 * runs, and every value reaches Postgres as a bind parameter — there is no
 * free-form SQL path to reach. Results are row-capped by MAX_ROWS, and the data
 * is entirely synthetic. No tool calls a model, so there is no token spend to
 * protect; the rate limit below exists to protect the database, not the bill.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport }
    from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { registerFoundryTools } from '@/lib/mcp';
import { TOOLS } from '@/lib/tools/index';
import { reserveMcpCall } from '@/lib/ratelimit';
import { DATASET_TODAY } from '@/lib/dataset';

// A JSON-RPC endpoint must never be prerendered or cached.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PUBLIC_URL = 'https://foundry-ops-ai.vercel.app/api/mcp';

/**
 * A fresh server and transport per request.
 *
 * Stateless (`sessionIdGenerator: undefined`) is not a simplification here, it
 * is the only correct choice: each invocation is an isolated serverless
 * function, so a session id minted on one request has nothing to resume on the
 * next. Every tool is an independent read, so there is no session state worth
 * keeping anyway.
 */
async function handle(request: Request): Promise<Response> {
    const server = new McpServer({ name: 'foundry-ops', version: '0.1.0' });
    registerFoundryTools(server);

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
    });
    await server.connect(transport);

    return transport.handleRequest(request);
}

export async function POST(request: Request): Promise<Response> {
    const quota = await reserveMcpCall(request);
    if (!quota.allowed) {
        return Response.json({ error: quota.reason }, { status: 429 });
    }
    return handle(request);
}

/**
 * GET is how a streamable-HTTP client opens its event stream — but it is also
 * what happens when a human pastes this URL into a browser, and answering that
 * with a JSON-RPC parse error is a poor introduction for the one endpoint whose
 * entire purpose is to be found. Sniff the Accept header: protocol clients ask
 * for text/event-stream, browsers do not.
 */
export async function GET(request: Request): Promise<Response> {
    if (request.headers.get('accept')?.includes('text/event-stream')) {
        return handle(request);
    }

    return Response.json({
        name: 'foundry-ops',
        protocol: 'Model Context Protocol (streamable HTTP)',
        tools: TOOLS.length,
        plant_date: DATASET_TODAY,
        data: 'synthetic — no real plant or customer data',
        connect: `claude mcp add --transport http foundry-ops ${PUBLIC_URL}`,
        docs: 'https://github.com/nwcarlson-dev/foundry-ops-ai/blob/main/docs/MCP.md',
    });
}
