/**
 * Scrap analysis. Epicor records where a defect was FOUND; for gas porosity and
 * shrink the cause is upstream on the melt deck, which is why these tools pair
 * with heat_history_for_job and machine_signal_for_job.
 */
import { z } from 'zod';
import { query } from '../db';
import { DATASET_TODAY } from '../dataset';
import { defineTool, capRows, round, toNum, pct, type ToolResult } from './types';

const DEPTS = ['MELT', 'MOLD', 'CORE', 'CLEAN', 'HEAT_TREAT', 'MACHINE'] as const;

export const scrapByReason = defineTool({
    name: 'scrap_by_reason',
    description:
        'Scrap quantity and rate grouped by Epicor reason code, sliceable by part, work ' +
        'center, department, customer, or date window. Use this to answer "what is driving ' +
        'scrap" before drilling into a cause.',
    sources: ['epicor'],
    schema: z.object({
        part_num: z.string().optional().describe('Exact part number, e.g. 4471-BRKT'),
        wc_code: z.string().optional().describe('Work center, e.g. MOLD-L2'),
        dept: z.enum(DEPTS).optional(),
        customer_code: z.string().optional(),
        days_back: z.number().int().min(1).max(600).default(90)
            .describe('Window ending at the current dataset date'),
        group_by_part: z.boolean().default(false)
            .describe('Break the result out by part number as well as reason code'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const daysBack = input.days_back ?? 90;
        const groupByPart = input.group_by_part ?? false;

        const rows = await query(
            `WITH scoped AS (
                 SELECT sd.reason_code, sd.scrap_qty, jh.part_num, jh.qty_ordered, jh.job_num
                 FROM epicor.scrap_dtl sd
                 JOIN epicor.job_head jh ON jh.job_num = sd.job_num
                 JOIN epicor.part p     ON p.part_num = jh.part_num
                 JOIN epicor.job_oper jo
                        ON jo.job_num = sd.job_num AND jo.oper_seq = sd.oper_seq
                 JOIN epicor.work_center wc ON wc.wc_code = jo.wc_code
                 WHERE sd.logged_at >= $1::date - ($2 || ' days')::interval
                   AND sd.logged_at <= $1::date
                   AND ($3::text IS NULL OR jh.part_num = $3)
                   AND ($4::text IS NULL OR jo.wc_code = $4)
                   AND ($5::text IS NULL OR wc.dept = $5)
                   AND ($6::text IS NULL OR p.customer_code = $6)
             ),
             ordered_qty AS (
                 SELECT SUM(qty_ordered) AS total_ordered
                 FROM (SELECT DISTINCT job_num, qty_ordered FROM scoped) j
             )
             SELECT s.reason_code, sr.description, sr.category,
                    ${groupByPart ? 's.part_num,' : ''}
                    SUM(s.scrap_qty)::int AS scrap_qty,
                    (SELECT total_ordered FROM ordered_qty)::int AS qty_ordered_in_scope
             FROM scoped s
             JOIN epicor.scrap_reason sr ON sr.reason_code = s.reason_code
             GROUP BY s.reason_code, sr.description, sr.category
                      ${groupByPart ? ', s.part_num' : ''}
             ORDER BY scrap_qty DESC`,
            [
                DATASET_TODAY, daysBack,
                input.part_num ?? null, input.wc_code ?? null,
                input.dept ?? null, input.customer_code ?? null,
            ],
        );

        const list = rows as Array<Record<string, unknown>>;
        const totalScrap = list.reduce((s, r) => s + (toNum(r.scrap_qty) ?? 0), 0);
        const orderedInScope = toNum(list[0]?.qty_ordered_in_scope) ?? 0;

        if (list.length === 0) notes.push('No scrap recorded for those filters in that window.');

        return {
            sources: ['epicor'],
            data: {
                window_days: daysBack,
                as_of: DATASET_TODAY,
                total_scrap_qty: totalScrap,
                qty_ordered_in_scope: orderedInScope,
                overall_scrap_rate_pct: pct(totalScrap, orderedInScope),
                by_reason: capRows(
                    list.map((r) => ({
                        reason_code: r.reason_code,
                        description: r.description,
                        category: r.category,
                        ...(groupByPart ? { part_num: r.part_num } : {}),
                        scrap_qty: toNum(r.scrap_qty),
                        pct_of_scrap: pct(r.scrap_qty, totalScrap),
                    })),
                    notes,
                ),
            },
            notes,
        };
    },
});

// ---------------------------------------------------------------------------

export const scrapTrend = defineTool({
    name: 'scrap_trend',
    description:
        'Weekly scrap trend for one reason code, with week-over-week change and a comparison ' +
        'of the recent period against the earlier baseline. Use this to establish whether ' +
        'something is actually getting worse before hunting for a cause.',
    sources: ['epicor'],
    schema: z.object({
        reason_code: z.string().describe('Epicor scrap reason code, e.g. GASPOR'),
        part_num: z.string().optional(),
        wc_code: z.string().optional(),
        weeks_back: z.number().int().min(4).max(78).default(16),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const weeks = input.weeks_back ?? 16;

        const rows = await query(
            `WITH scoped AS (
                 SELECT date_trunc('week', sd.logged_at)::date AS week,
                        sd.reason_code, sd.scrap_qty
                 FROM epicor.scrap_dtl sd
                 JOIN epicor.job_head jh ON jh.job_num = sd.job_num
                 JOIN epicor.job_oper jo
                        ON jo.job_num = sd.job_num AND jo.oper_seq = sd.oper_seq
                 WHERE sd.logged_at >= $1::date - ($2 || ' weeks')::interval
                   AND sd.logged_at <= $1::date
                   AND ($4::text IS NULL OR jh.part_num = $4)
                   AND ($5::text IS NULL OR jo.wc_code = $5)
             )
             SELECT week,
                    SUM(scrap_qty) FILTER (WHERE reason_code = $3)::int AS reason_qty,
                    SUM(scrap_qty)::int AS all_scrap_qty
             FROM scoped GROUP BY week ORDER BY week`,
            [
                DATASET_TODAY, weeks, input.reason_code,
                input.part_num ?? null, input.wc_code ?? null,
            ],
        );

        const series = (rows as Array<Record<string, unknown>>).map((r) => ({
            week: r.week,
            qty: toNum(r.reason_qty) ?? 0,
            all_scrap_qty: toNum(r.all_scrap_qty) ?? 0,
            pct_of_scrap: pct(r.reason_qty ?? 0, r.all_scrap_qty),
        }));

        // Compare the most recent third against the earliest third — enough
        // separation to distinguish a trend from week-to-week noise.
        const third = Math.max(1, Math.floor(series.length / 3));
        const early = series.slice(0, third);
        const recent = series.slice(-third);
        const avg = (xs: typeof series, key: 'qty') =>
            xs.length ? xs.reduce((s, x) => s + x[key], 0) / xs.length : 0;
        const earlyAvg = avg(early, 'qty');
        const recentAvg = avg(recent, 'qty');

        if (series.length === 0) {
            notes.push(`No ${input.reason_code} scrap recorded in that window.`);
        }

        return {
            sources: ['epicor'],
            data: {
                reason_code: input.reason_code,
                weeks: series.length,
                series,
                baseline_weekly_avg: round(earlyAvg, 1),
                recent_weekly_avg: round(recentAvg, 1),
                change_pct: earlyAvg > 0 ? round(((recentAvg - earlyAvg) / earlyAvg) * 100, 1) : null,
                direction: recentAvg > earlyAvg * 1.25 ? 'WORSENING'
                         : recentAvg < earlyAvg * 0.75 ? 'IMPROVING' : 'FLAT',
            },
            notes,
        };
    },
});
