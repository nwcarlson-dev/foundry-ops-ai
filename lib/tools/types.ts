/**
 * The tool contract.
 *
 * One definition serves three consumers: the Claude tool-use loop in the chat
 * route, the MCP stdio server, and the unit tests. They share the same Zod
 * schema and the same implementation, which is the point — "a unified AI layer
 * over our existing systems" demonstrated rather than asserted.
 *
 * Two design rules, both deliberate and both stated in the README:
 *
 *   1. The model never writes SQL. It picks a tool and supplies typed
 *      parameters; every value reaches Postgres as a bind parameter. A plant
 *      should not have to trust that a language model will not write DELETE.
 *
 *   2. Every result declares which source systems it touched. The UI renders
 *      that as a chip, and the model is instructed to attribute numbers to
 *      systems in prose. A number without a provenance is not useful to a
 *      supervisor who has to act on it.
 */
import { z } from 'zod';

/** The four systems this copilot reasons across, plus the bridge between them. */
export type SourceSystem = 'epicor' | 'thrive' | 'ignition' | 'monday' | 'xref';

export interface ToolResult {
    /** Which source systems produced this answer. Rendered as UI chips. */
    sources: SourceSystem[];
    /** Compact payload for the model. Keep it small. */
    data: unknown;
    /**
     * Caveats the model is expected to pass along — truncation, reconciliation
     * gaps, empty results. Surfacing these is what keeps an answer honest.
     */
    notes?: string[];
}

export interface ToolDef<TSchema extends z.ZodType = z.ZodType> {
    name: string;
    /** Written for the model: what it answers and when to reach for it. */
    description: string;
    sources: SourceSystem[];
    schema: TSchema;
    run(input: z.infer<TSchema>): Promise<ToolResult>;
}

/** Helper so each tool file stays terse while keeping full type inference. */
export function defineTool<TSchema extends z.ZodType>(
    def: ToolDef<TSchema>,
): ToolDef<TSchema> {
    return def;
}

// ---------------------------------------------------------------------------
// Result shaping
//
// Tool results are re-sent to the model on every subsequent turn of the loop,
// so an oversized result is paid for repeatedly. These keep them small.
// ---------------------------------------------------------------------------

/** Row ceiling for any single tool result. */
export const MAX_ROWS = 60;

/** Truncate to MAX_ROWS and report the truncation rather than hiding it. */
export function capRows<T>(rows: T[], notes: string[], limit = MAX_ROWS): T[] {
    if (rows.length <= limit) return rows;
    notes.push(
        `Showing the first ${limit} of ${rows.length} rows. Narrow the filters for the rest.`,
    );
    return rows.slice(0, limit);
}

/** Round to n decimals, passing null/undefined through untouched. */
export function round(value: unknown, decimals = 2): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const f = 10 ** decimals;
    return Math.round(n * f) / f;
}

/** Postgres returns NUMERIC as a string to preserve precision; coerce safely. */
export function toNum(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Percentage with one decimal, guarding divide-by-zero. */
export function pct(numerator: unknown, denominator: unknown): number | null {
    const a = toNum(numerator);
    const b = toNum(denominator);
    if (a === null || b === null || b === 0) return null;
    return round((a / b) * 100, 1);
}
