/**
 * The tool registry.
 *
 * This single list is consumed by three things:
 *   - app/api/chat  — the Claude tool-use loop
 *   - mcp/server.ts — the MCP stdio server
 *   - tests/        — unit tests asserting each tool's numbers
 *
 * One definition, three surfaces. That is the "unified AI layer over existing
 * systems" claim made concrete: the MCP server is not a reimplementation, it is
 * the same functions behind a different transport.
 */
import { z } from 'zod';
import type { ToolDef, ToolResult, SourceSystem } from './types';

import { getOpenJobs, getJobDetail, atRiskJobs } from './jobs';
import { scrapByReason, scrapTrend } from './scrap';
import { laborEfficiency, workCenterLoad, jobCostSummary } from './ops';
import {
    heatHistoryForJob,
    machineSignalForJob,
    customerCommitmentsForJob,
    reconciliationReport,
} from './crosssource';

export type { ToolDef, ToolResult, SourceSystem };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolDef<any>[] = [
    // Epicor-only
    getOpenJobs,
    getJobDetail,
    atRiskJobs,
    scrapByReason,
    scrapTrend,
    laborEfficiency,
    workCenterLoad,
    jobCostSummary,
    // Cross-source — these are the ones that answer questions no single
    // system can.
    heatHistoryForJob,
    machineSignalForJob,
    customerCommitmentsForJob,
    reconciliationReport,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Execute a tool by name with unvalidated input.
 *
 * Input is parsed through the tool's Zod schema before it reaches any query, so
 * a malformed or hostile tool call fails here rather than in the database. The
 * error is returned as a value rather than thrown so the agent loop can hand it
 * back to the model and let it correct itself.
 */
export async function runTool(
    name: string,
    rawInput: unknown,
): Promise<ToolResult & { error?: string }> {
    const tool = TOOLS_BY_NAME.get(name);
    if (!tool) {
        return { sources: [], data: null, error: `Unknown tool "${name}".` };
    }

    const parsed = tool.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
        return {
            sources: [],
            data: null,
            error:
                `Invalid input for ${name}: ` +
                parsed.error.issues
                    .map((i: z.core.$ZodIssue) =>
                        `${i.path.join('.') || '(root)'} ${i.message}`)
                    .join('; '),
        };
    }

    try {
        return await tool.run(parsed.data);
    } catch (err) {
        return {
            sources: tool.sources,
            data: null,
            error: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/** JSON Schema for a tool's input, for the Anthropic and MCP tool definitions. */
export function toolInputSchema(tool: ToolDef): Record<string, unknown> {
    return z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>;
}
