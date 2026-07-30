/**
 * MCP server integration tests.
 *
 * Spawns mcp/server.ts as a real subprocess and speaks the actual protocol to
 * it over stdio. That matters more than it sounds: the failure mode for a stdio
 * MCP server is a stray write to stdout corrupting the JSON-RPC stream, which
 * no amount of unit testing the tool layer would catch. If these pass, Claude
 * Desktop can talk to it.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });

let client: Client;
let transport: StdioClientTransport;

before(async () => {
    transport = new StdioClientTransport({
        command: 'npx',
        args: ['tsx', 'mcp/server.ts'],
        env: {
            PATH: process.env.PATH ?? '',
            DATABASE_URL: process.env.DATABASE_URL ?? '',
        },
        stderr: 'pipe',
    });
    client = new Client({ name: 'foundry-mcp-test', version: '0.0.0' });
    await client.connect(transport);
});

after(async () => {
    await client?.close().catch(() => {});
});

/** Parse the JSON payload out of a tool result's text content. */
function payload(result: unknown): Record<string, unknown> {
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    assert.ok(Array.isArray(content) && content.length > 0, 'no content returned');
    assert.equal(content[0].type, 'text');
    return JSON.parse(content[0].text ?? '{}') as Record<string, unknown>;
}

describe('mcp server', () => {
    test('advertises every tool in the registry', async () => {
        const { tools } = await client.listTools();
        assert.equal(tools.length, 12);

        const names = tools.map((t) => t.name).sort();
        assert.ok(names.includes('reconciliation_report'));
        assert.ok(names.includes('heat_history_for_job'));

        for (const t of tools) {
            assert.ok(t.description && t.description.length > 40, `${t.name} description too thin`);
            // Provenance has to travel in the description: an MCP client has no
            // source chips to render.
            assert.match(t.description, /Reads from: /, `${t.name} does not declare its sources`);
            assert.equal(t.inputSchema.type, 'object', `${t.name} has no object input schema`);
        }
    });

    test('marks tools read-only so a client can trust them', async () => {
        const { tools } = await client.listTools();
        for (const t of tools) {
            assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is not marked read-only`);
            assert.equal(t.annotations?.destructiveHint, false, `${t.name} is not marked non-destructive`);
        }
    });

    test('a cross-source call round-trips with real data', async () => {
        const result = await client.callTool({
            name: 'reconciliation_report',
            arguments: { include_unmatched_detail: true },
        });

        const data = payload(result).data as {
            match_rates: Array<{ source_pair: string; match_pct: number }>;
            unmatched_detail: unknown[];
        };
        assert.ok(data.match_rates.length >= 4, 'expected match rates for every bridge');
        assert.ok(data.unmatched_detail.length > 0, 'expected unmatched records to be surfaced');
        assert.deepEqual(payload(result).sources, ['xref', 'epicor', 'thrive', 'ignition', 'monday']);
    });

    test('scrap trend comes back through the protocol intact', async () => {
        const result = await client.callTool({
            name: 'scrap_trend',
            arguments: { reason_code: 'GASPOR', part_num: '4471-BRKT', weeks_back: 16 },
        });
        const data = payload(result).data as { direction: string; series: unknown[] };
        assert.equal(data.direction, 'WORSENING');
        assert.ok(data.series.length > 4);
    });

    test('an invalid argument is reported as an error, not a crash', async () => {
        const result = await client.callTool({
            name: 'scrap_trend',
            arguments: { reason_code: 'GASPOR', weeks_back: 9999 },
        });
        // Either the SDK rejects it against the schema or our own validation
        // does; both are acceptable, a dead server is not.
        assert.ok((result as { isError?: boolean }).isError, 'expected an error result');

        // The connection must still be usable afterwards.
        const { tools } = await client.listTools();
        assert.equal(tools.length, 12);
    });
});
