/**
 * Hosted MCP endpoint tests.
 *
 * The stdio suite in mcp.test.ts spawns a real subprocess because its failure
 * mode is a stray stdout write corrupting the stream. The HTTP transport has a
 * different failure mode — wrong content type, a session it cannot resume, or a
 * response body that never gets flushed — so this calls the route handler
 * directly with real Request objects. No server to boot, same node --test run.
 *
 * What these protect: that the deployed URL a reviewer is told to point their
 * client at actually speaks the protocol, and that the endpoint stays usable
 * without a session handshake, which is what statelessness buys on serverless.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';

import { GET, POST } from '../app/api/mcp/route';
import { TOOLS } from '../lib/tools/index';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });

const RPC_HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
};

function rpc(method: string, params?: unknown, id = 1): Request {
    return new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: RPC_HEADERS,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
    });
}

/**
 * Pull the JSON-RPC payload out of the response.
 *
 * The transport prefers SSE, so a single reply arrives as an `event:`/`data:`
 * frame rather than a bare JSON body.
 */
async function rpcResult(res: Response): Promise<Record<string, unknown>> {
    const body = await res.text();
    const line = body.split('\n').find((l) => l.startsWith('data:'));
    assert.ok(line, `no data frame in response: ${body.slice(0, 200)}`);
    const msg = JSON.parse(line.slice(5).trim());
    assert.ok(!msg.error, `JSON-RPC error: ${JSON.stringify(msg.error)}`);
    return msg.result as Record<string, unknown>;
}

describe('hosted MCP endpoint', () => {
    test('initialize returns a protocol version and server identity', async () => {
        const result = await rpcResult(await POST(rpc('initialize', {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
        })));

        assert.ok(result.protocolVersion, 'no protocolVersion negotiated');
        assert.equal((result.serverInfo as { name: string }).name, 'foundry-ops');
    });

    test('serves every tool the stdio server and the chat loop serve', async () => {
        const result = await rpcResult(await POST(rpc('tools/list', undefined, 2)));
        const tools = result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;

        assert.equal(tools.length, TOOLS.length,
            'HTTP transport exposes a different tool count than the registry');
        assert.deepEqual(
            tools.map((t) => t.name).sort(),
            TOOLS.map((t) => t.name).sort(),
            'the two transports disagree about which tools exist',
        );
    });

    test('every tool is advertised as read-only', async () => {
        const result = await rpcResult(await POST(rpc('tools/list', undefined, 3)));
        const tools = result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;

        for (const tool of tools) {
            assert.equal(tool.annotations?.readOnlyHint, true,
                `${tool.name} is not marked read-only — a client could treat it as mutating`);
        }
    });

    test('a tool call returns data with its source systems attributed', async () => {
        const result = await rpcResult(await POST(rpc('tools/call', {
            name: 'scrap_by_reason',
            arguments: { part_num: '4471-BRKT', days: 90 },
        }, 4)));

        const content = result.content as Array<{ type: string; text: string }>;
        const payload = JSON.parse(content[0].text) as { sources: string[]; data: unknown };

        assert.ok(payload.sources.includes('epicor'), 'scrap data did not cite Epicor');
        assert.ok(payload.data, 'no data returned');
    });

    test('works with no session handshake, which is what serverless needs', async () => {
        // A cold function cannot resume a session minted by a previous one. If
        // this ever starts failing, the endpoint has become stateful and will
        // break intermittently in production rather than here.
        const result = await rpcResult(await POST(rpc('tools/list', undefined, 5)));
        assert.ok(Array.isArray(result.tools));
    });

    test('a browser GET explains how to connect instead of erroring', async () => {
        const res = await GET(new Request('http://localhost/api/mcp'));
        const body = await res.json() as Record<string, unknown>;

        assert.equal(res.status, 200);
        assert.equal(body.tools, TOOLS.length);
        assert.match(String(body.connect), /claude mcp add --transport http/);
    });
});
