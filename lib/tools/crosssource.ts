/**
 * The cross-source tools. These are the reason this project exists.
 *
 * Epicor knows job numbers. Thrive knows heat numbers and its own pattern codes.
 * Ignition knows tag paths and timestamps and nothing else. monday.com knows
 * numeric item IDs and whatever a human typed into a text column. None of them
 * share a key, so each tool below crosses a bridge in the xref schema, and each
 * reports what failed to cross rather than quietly under-reporting.
 */
import { z } from 'zod';
import { query, queryOne } from '../db';
import { DATASET_TODAY } from '../dataset';
import { defineTool, capRows, round, toNum, type ToolResult } from './types';

/** Resolve whatever the user typed into a canonical Epicor job number. */
async function resolveJobNum(raw: string): Promise<string> {
    const row = await queryOne<{ job_num: string | null }>(
        `SELECT xref.normalize_job_ref($1) AS job_num`, [raw],
    );
    return row?.job_num ?? raw;
}

// ---------------------------------------------------------------------------

export const heatHistoryForJob = defineTool({
    name: 'heat_history_for_job',
    description:
        'Melt-deck history from Thrive for the heats a job was poured from: degas time, ' +
        'furnace, yield, and reduced-pressure-test density. Thrive does not know Epicor job ' +
        'numbers, so this crosses the part-to-pattern bridge and then bounds by the job\'s ' +
        'time window. Reach for this whenever scrap looks melt-related — gas porosity, ' +
        'shrink, or inclusions.',
    sources: ['epicor', 'thrive', 'xref'],
    schema: z.object({
        job_num: z.string().describe('Epicor job number, e.g. J-100864'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const jobNum = await resolveJobNum(input.job_num);

        const mapping = await queryOne(
            `SELECT jp.job_num, jp.part_num, jp.pattern_code
             FROM xref.job_pattern jp WHERE jp.job_num = $1`,
            [jobNum],
        );

        if (!mapping) {
            return { sources: ['epicor', 'xref'], data: null, notes: [`No job ${jobNum} in Epicor.`] };
        }
        if (!(mapping as Record<string, unknown>).pattern_code) {
            return {
                sources: ['epicor', 'thrive', 'xref'],
                data: { job_num: jobNum, part_num: (mapping as Record<string, unknown>).part_num, heats: [] },
                notes: [
                    `Part ${(mapping as Record<string, unknown>).part_num} has no pattern mapping in ` +
                    `xref.part_pattern, so its Thrive melt history cannot be resolved. This is a known ` +
                    `gap — see reconciliation_report.`,
                ],
            };
        }

        // DISTINCT matters: xref.job_heat is distinct on (job, heat, poured_at),
        // so a heat that poured this job's pattern more than once appears more
        // than once. Without it the heat count inflates and the degas average
        // gets weighted by pour count instead of by heat.
        const heats = await query(
            `SELECT DISTINCT h.heat_num, h.furnace_id, h.alloy_spec,
                    h.poured_at::text AS poured_at,
                    h.degas_minutes, h.rpt_density,
                    h.lbs_charged, h.lbs_poured, h.lbs_returns,
                    ROUND((h.lbs_poured / NULLIF(h.lbs_charged, 0) * 100)::numeric, 1) AS yield_pct
             FROM xref.job_heat jh
             JOIN thrive.heat h ON h.heat_num = jh.heat_num
             WHERE jh.job_num = $1
             ORDER BY poured_at`,
            [jobNum],
        );

        const list = heats as Array<Record<string, unknown>>;
        const degasValues = list.map((h) => toNum(h.degas_minutes)).filter((v): v is number => v !== null);
        const rptValues = list.map((h) => toNum(h.rpt_density)).filter((v): v is number => v !== null);
        const avgDegas = degasValues.length
            ? degasValues.reduce((a, b) => a + b, 0) / degasValues.length : null;

        // A furnace-wide baseline for the same period gives the model something
        // to compare against, so it can say "below normal" rather than just
        // quoting a number the reader has no reference for.
        const furnaces = [...new Set(list.map((h) => String(h.furnace_id)))];
        let baseline: Record<string, unknown> | null = null;
        if (furnaces.length === 1) {
            baseline = await queryOne(
                `SELECT ROUND(AVG(degas_minutes)::numeric, 2) AS baseline_degas_minutes,
                        ROUND(AVG(rpt_density)::numeric, 3)   AS baseline_rpt_density
                 FROM thrive.heat
                 WHERE furnace_id = $1
                   AND poured_at < $2::date - INTERVAL '90 days'`,
                [furnaces[0], DATASET_TODAY],
            );
        }

        if (list.length === 0) {
            notes.push(
                'The pattern is mapped but no Thrive pour records fall inside this job\'s ' +
                'labour window, so no heats resolved.',
            );
        }
        if (rptValues.length < list.length) {
            notes.push('Reduced-pressure test is a per-shift sample, so it is not run on every heat.');
        }

        return {
            sources: ['epicor', 'thrive', 'xref'],
            data: {
                job_num: jobNum,
                part_num: (mapping as Record<string, unknown>).part_num,
                pattern_code: (mapping as Record<string, unknown>).pattern_code,
                heat_count: list.length,
                avg_degas_minutes: round(avgDegas, 2),
                furnace_baseline: baseline,
                heats: capRows(list, notes),
            },
            notes,
        };
    },
});

// ---------------------------------------------------------------------------

export const machineSignalForJob = defineTool({
    name: 'machine_signal_for_job',
    description:
        'Ignition historian readings and downtime events covering a job\'s run window. The ' +
        'historian carries no job, part, or heat identifier at all, so this crosses the work ' +
        'centre to tag-path bridge and bounds by the job\'s time window. Use it to corroborate ' +
        'a melt or process finding against independent machine data.',
    sources: ['epicor', 'ignition', 'xref'],
    schema: z.object({
        job_num: z.string().describe('Epicor job number, e.g. J-100864'),
        signal_role: z.enum(['DEGAS', 'TEMP', 'CYCLE', 'COUNT', 'STATE']).optional()
            .describe('Restrict to one kind of signal'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const jobNum = await resolveJobNum(input.job_num);

        const win = await queryOne(
            `SELECT started_at::text, ended_at::text FROM xref.job_window WHERE job_num = $1`,
            [jobNum],
        );
        if (!win) {
            return { sources: ['epicor', 'xref'], data: null, notes: [`No job ${jobNum} in Epicor.`] };
        }

        const tags = await query(
            `SELECT wt.wc_code, wt.signal_role, th.tag_path,
                    COUNT(*)::int AS samples,
                    ROUND(AVG(th.value_float)::numeric, 2) AS avg_value,
                    ROUND(MIN(th.value_float)::numeric, 2) AS min_value,
                    ROUND(MAX(th.value_float)::numeric, 2) AS max_value
             FROM epicor.job_oper jo
             JOIN xref.wc_tag wt ON wt.wc_code = jo.wc_code
             JOIN xref.job_window w ON w.job_num = jo.job_num
             JOIN ignition.tag_history th
                    ON th.tag_path LIKE wt.tag_prefix || '/%'
                   AND th.ts >= w.started_at AND th.ts <= w.ended_at
             WHERE jo.job_num = $1
               AND ($2::text IS NULL OR wt.signal_role = $2)
             GROUP BY 1, 2, 3 ORDER BY wt.wc_code, th.tag_path`,
            [jobNum, input.signal_role ?? null],
        );

        const downtime = await query(
            `SELECT wt.wc_code, de.tag_path,
                    de.started_at::text AS started_at, de.ended_at::text AS ended_at,
                    ROUND((EXTRACT(EPOCH FROM (de.ended_at - de.started_at)) / 3600)::numeric, 2) AS down_hrs,
                    de.reason_text
             FROM epicor.job_oper jo
             JOIN xref.wc_tag wt ON wt.wc_code = jo.wc_code
             JOIN xref.job_window w ON w.job_num = jo.job_num
             JOIN ignition.downtime_event de
                    ON de.tag_path LIKE wt.tag_prefix || '/%'
                   AND de.started_at >= w.started_at AND de.started_at <= w.ended_at
             WHERE jo.job_num = $1
             ORDER BY de.started_at`,
            [jobNum],
        );

        if ((tags as unknown[]).length === 0) {
            notes.push(
                'No historian tags resolved for this job\'s work centres. Not every work ' +
                'centre is instrumented — see reconciliation_report.',
            );
        }
        notes.push('Historian values are sampled every 2 hours (see docs/DATA.md).');

        return {
            sources: ['epicor', 'ignition', 'xref'],
            data: {
                job_num: jobNum,
                window: win,
                tags: capRows(tags as unknown[], notes),
                downtime_events: capRows(downtime as unknown[], notes),
            },
            notes,
        };
    },
});

// ---------------------------------------------------------------------------

export const customerCommitmentsForJob = defineTool({
    name: 'customer_commitments_for_job',
    description:
        'monday.com board items tied to a job — expedites, quality holds, PPAP launches — ' +
        'with promised dates and status. The board stores its job reference as free text ' +
        'typed by humans in several formats, so this crosses the normalisation bridge. Use it ' +
        'to answer whether a customer is exposed by a production problem.',
    sources: ['epicor', 'monday', 'xref'],
    schema: z.object({
        job_num: z.string().optional().describe('Epicor job number. Omit to list all open commitments.'),
        status: z.string().optional().describe('Filter by board status, e.g. Stuck'),
        customer: z.string().optional().describe('monday.com customer display name, e.g. Deere & Co'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const jobNum = input.job_num ? await resolveJobNum(input.job_num) : null;

        const rows = await query(
            `SELECT m.item_id, m.board_name, m.item_name, m.status, m.customer,
                    m.promised_date::text AS promised_date,
                    m.raw_job_ref, m.resolved_job_num,
                    jh.part_num, jh.req_due_date::text AS job_due_date,
                    (m.promised_date - $1::date) AS days_to_promise,
                    (SELECT cv.text_value FROM monday.column_value cv
                      WHERE cv.item_id = m.item_id AND cv.column_title = 'Notes') AS notes_text,
                    (SELECT cv.text_value FROM monday.column_value cv
                      WHERE cv.item_id = m.item_id AND cv.column_title = 'Priority') AS priority
             FROM xref.job_monday_item m
             LEFT JOIN epicor.job_head jh ON jh.job_num = m.resolved_job_num
             WHERE ($2::text IS NULL OR m.resolved_job_num = $2)
               AND ($3::text IS NULL OR m.status = $3)
               AND ($4::text IS NULL OR m.customer = $4)
               AND ($2::text IS NOT NULL OR jh.job_closed = FALSE)
             ORDER BY m.promised_date NULLS LAST`,
            [DATASET_TODAY, jobNum, input.status ?? null, input.customer ?? null],
        );

        const list = rows as Array<Record<string, unknown>>;

        // Surface the human-typed original alongside the normalised value. It
        // shows the reader the bridge actually did something.
        const formats = [...new Set(list.map((r) => String(r.raw_job_ref ?? '')))].slice(0, 5);

        if (list.length === 0) {
            notes.push(jobNum
                ? `No monday.com board items reference ${jobNum}.`
                : 'No open commitments match those filters.');
        }
        if (formats.length > 1) {
            notes.push(
                `Job references on the board were typed as: ${formats.map((f) => `"${f}"`).join(', ')} — ` +
                `all normalised through xref.normalize_job_ref().`,
            );
        }

        return {
            sources: ['epicor', 'monday', 'xref'],
            data: { job_num: jobNum, items: capRows(list, notes) },
            notes,
        };
    },
});

// ---------------------------------------------------------------------------

export const reconciliationReport = defineTool({
    name: 'reconciliation_report',
    description:
        'How well the four source systems reconcile: match rate per source pair, and the ' +
        'specific records that failed to match with the reason. Use this when the user asks ' +
        'how the systems connect, and cite it whenever a gap could make an answer incomplete — ' +
        'for example when a part has no Thrive pattern mapping.',
    sources: ['xref', 'epicor', 'thrive', 'ignition', 'monday'],
    schema: z.object({
        include_unmatched_detail: z.boolean().default(true)
            .describe('Include the individual records that failed to reconcile'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const includeDetail = input.include_unmatched_detail ?? true;

        const rates = await query(
            `SELECT source_pair, matched, total,
                    ROUND(100.0 * matched / NULLIF(total, 0), 1) AS match_pct
             FROM xref.match_rate ORDER BY match_pct`,
        );

        let unmatched: unknown[] = [];
        if (includeDetail) {
            unmatched = await query(
                `SELECT source_pair, identifier, reason FROM xref.unmatched
                 ORDER BY source_pair, identifier`,
            );
        }

        const summary = await query(
            `SELECT source_pair, COUNT(*)::int AS unmatched_count
             FROM xref.unmatched GROUP BY 1 ORDER BY 1`,
        );

        notes.push(
            'These bridges are hand-maintained and deliberately imperfect, which is what real ' +
            'cross-system reconciliation looks like. Match rates below 100% are expected, not a bug.',
        );

        return {
            sources: ['xref', 'epicor', 'thrive', 'ignition', 'monday'],
            data: {
                bridges: [
                    { bridge: 'epicor.part_num <-> thrive.pattern_code', mechanism: 'xref.part_pattern lookup table' },
                    { bridge: 'epicor.wc_code <-> ignition.tag_path', mechanism: 'xref.wc_tag prefix match plus a job time window' },
                    { bridge: 'epicor.job_num <-> monday free text', mechanism: 'xref.normalize_job_ref() pattern recovery' },
                ],
                match_rates: rates,
                unmatched_summary: summary,
                unmatched_detail: includeDetail ? capRows(unmatched, notes) : undefined,
            },
            notes,
        };
    },
});
