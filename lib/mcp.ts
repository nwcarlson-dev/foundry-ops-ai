/**
 * Registering the foundry tools on an MCP server.
 *
 * Deliberately transport-agnostic. Two entry points call this and nothing else
 * about them differs: mcp/server.ts speaks stdio to a local client, and
 * app/api/mcp/route.ts speaks streamable HTTP to anyone pointed at the
 * deployment. Both hand the same registry the same way.
 *
 * That is the whole argument the project makes about a "unified AI layer" —
 * lib/tools/ is defined once, and the chat loop, the two MCP transports, and
 * the tests are all consumers of it rather than reimplementations. Anything
 * added here reaches every transport at once; anything added to only one of
 * them is a bug.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TOOLS, runTool } from './tools/index';
import { DATASET_TODAY } from './dataset';

export function registerFoundryTools(server: McpServer): void {
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
}
