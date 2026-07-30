#!/usr/bin/env -S npx tsx
/**
 * MCP stdio server over the foundry tool layer.
 *
 * This is not a reimplementation. It imports the same TOOLS registry the web
 * chat uses and exposes it over a different transport — which is the point the
 * project is making: one typed, allowlisted tool layer over four disconnected
 * plant systems, reachable from anything that speaks MCP.
 *
 * Point Claude Desktop or Claude Code at this and ask it about the plant. Setup
 * is in docs/MCP.md.
 *
 * IMPORTANT: on stdio, stdout belongs to the protocol. Anything written there
 * that is not a JSON-RPC message corrupts the stream and the client disconnects
 * with an opaque parse error. All logging in this file goes to stderr.
 */
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { TOOLS, runTool } from '../lib/tools/index';
import { DATASET_TODAY } from '../lib/dataset';

// Resolve env relative to THIS FILE, not the working directory. An MCP client
// launches the server from wherever it happens to be running, so a cwd-relative
// path silently finds nothing and the server dies on a missing DATABASE_URL.
const projectRoot = join(__dirname, '..');
loadEnv({ path: join(projectRoot, '.env.local'), quiet: true });
loadEnv({ path: join(projectRoot, '.env'), quiet: true });

const log = (...args: unknown[]) => console.error('[foundry-mcp]', ...args);

async function main() {
    if (!process.env.DATABASE_URL) {
        log('DATABASE_URL is not set. Create .env.local — see .env.example.');
        process.exit(1);
    }

    const server = new McpServer({
        name: 'foundry-ops',
        version: '0.1.0',
    });

    for (const tool of TOOLS) {
        server.registerTool(
            tool.name,
            {
                title: tool.name,
                // Tell the client which systems this reads from. An MCP client
                // has none of the web UI's chips, so provenance has to travel
                // in the description and in the payload.
                description:
                    `${tool.description}\n\n` +
                    `Reads from: ${tool.sources.join(', ')}. Read-only. ` +
                    `Plant date is ${DATASET_TODAY}.`,
                inputSchema: tool.schema,
                annotations: {
                    readOnlyHint: true,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            async (args: unknown) => {
                const result = await runTool(tool.name, args);

                if (result.error) {
                    return {
                        isError: true,
                        content: [{ type: 'text' as const, text: result.error }],
                    };
                }

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(
                                {
                                    sources: result.sources,
                                    data: result.data,
                                    ...(result.notes?.length ? { notes: result.notes } : {}),
                                },
                                null,
                                2,
                            ),
                        },
                    ],
                };
            },
        );
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);

    log(`ready — ${TOOLS.length} tools, plant date ${DATASET_TODAY}`);
}

main().catch((err) => {
    log('failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
});
