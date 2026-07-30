/**
 * Operational tools: labor efficiency, work centre loading, and cost roll-ups
 * across many jobs.
 */
import { z } from 'zod';
import { query } from '../db';
import { DATASET_TODAY, LABOR_RATE_PER_HR, DEFAULT_LABOR_RATE, ALUMINUM_COST_PER_LB } from '../dataset';
import { defineTool, capRows, round, toNum, pct, type ToolResult } from './types';

const DEPTS = ['MELT', 'MOLD', 'CORE', 'CLEAN', 'HEAT_TREAT', 'MACHINE'] as const;

// ---------------------------------------------------------------------------

export const laborEfficiency = defineTool({
    name: 'labor_efficiency',
    description:
        'Actual hours against standard (estimated) hours, grouped by operator, shift, work ' +
        'centre, or part. A ratio above 1.0 means the work took longer than the standard. ' +
        'Grouping by operator within one work centre is how you tell a training or staffing ' +
        'problem (a few operators over) from a wrong standard (everyone over by a similar ' +
        'margin).',
    sources: ['epicor'],
    schema: z.object({
        group_by: z.enum(['employee', 'shift', 'work_center', 'part'])
            .describe('Dimension to group the ratio by'),
        wc_code: z.string().optional().describe('Restrict to one work centre, e.g. MOLD-L2'),
        dept: z.enum(DEPTS).optional(),
        part_num: z.string().optional(),
        oper_seq: z.number().int().optional()
            .describe('Restrict to one operation sequence, e.g. 30 for the clean/finish op'),
        days_back: z.number().int().min(7).max(600).default(120),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const daysBack = input.days_back ?? 120;

        // Column on the op_labor CTE below. Not interpolated user input — the
        // Zod enum constrains this to exactly these four values.
        const groupCol = {
            employee: 'ol.employee_num',
            shift: 'ol.shift::text',
            work_center: 'ol.wc_code',
            part: 'ol.part_num',
        }[input.group_by];

        const rows = await query(
            `WITH op_labor AS (
                 -- One row per (job, operation): its estimate, its actual, and
                 -- the shift/operator that ran it. Aggregating labor first
                 -- avoids multiplying the operation's hours by crew size.
                 SELECT jo.job_num, jo.oper_seq, jo.wc_code, jh.part_num,
                        jo.est_setup_hrs + jo.est_prod_hrs AS est_hrs,
                        jo.act_setup_hrs + jo.act_prod_hrs AS act_hrs,
                        MIN(ld.shift)         AS shift,
                        MIN(ld.employee_num)  AS employee_num,
                        MIN(ld.clock_in)      AS started
                 FROM epicor.job_oper jo
                 JOIN epicor.job_head jh ON jh.job_num = jo.job_num
                 JOIN epicor.labor_dtl ld
                        ON ld.job_num = jo.job_num AND ld.oper_seq = jo.oper_seq
                 JOIN epicor.work_center wc ON wc.wc_code = jo.wc_code
                 WHERE jo.est_prod_hrs > 0
                   AND jo.act_prod_hrs > 0
                   AND ld.clock_in >= $1::date - ($2 || ' days')::interval
                   AND ($3::text IS NULL OR jo.wc_code = $3)
                   AND ($4::text IS NULL OR wc.dept = $4)
                   AND ($5::text IS NULL OR jh.part_num = $5)
                   AND ($6::int  IS NULL OR jo.oper_seq = $6)
                 GROUP BY jo.job_num, jo.oper_seq, jo.wc_code, jh.part_num,
                          jo.est_setup_hrs, jo.est_prod_hrs,
                          jo.act_setup_hrs, jo.act_prod_hrs
             )
             SELECT ${groupCol} AS group_key,
                    COUNT(*)::int AS operations,
                    ROUND(SUM(ol.est_hrs)::numeric, 1) AS est_hrs,
                    ROUND(SUM(ol.act_hrs)::numeric, 1) AS act_hrs,
                    ROUND((SUM(ol.act_hrs) / NULLIF(SUM(ol.est_hrs), 0))::numeric, 3) AS ratio
             FROM op_labor ol
             GROUP BY 1
             HAVING COUNT(*) >= 3
             ORDER BY ratio DESC NULLS LAST`,
            [
                DATASET_TODAY, daysBack,
                input.wc_code ?? null, input.dept ?? null,
                input.part_num ?? null, input.oper_seq ?? null,
            ],
        );

        const list = (rows as Array<Record<string, unknown>>).map((r) => ({
            [input.group_by]: r.group_key,
            operations: toNum(r.operations),
            est_hrs: toNum(r.est_hrs),
            act_hrs: toNum(r.act_hrs),
            ratio: toNum(r.ratio),
            over_standard_pct: round(((toNum(r.ratio) ?? 1) - 1) * 100, 1),
        }));

        if (list.length === 0) {
            notes.push('No completed operations match those filters (groups need at least 3 operations).');
        } else if (input.group_by === 'employee' && list.length >= 3) {
            // Distinguishing a wrong standard from a crew problem.
            //
            // Spread alone does not do it — operator ratios always vary from
            // sampling noise, so a wrong standard and a training gap can show
            // similar spreads. The discriminating question is whether the
            // FASTEST operator still misses the number: if nobody can hit it,
            // the number is wrong, regardless of how much the crew varies.
            const ratios = list.map((l) => l.ratio ?? 1);
            const fastest = Math.min(...ratios);
            const slowest = Math.max(...ratios);
            const spread = round(slowest - fastest, 2);

            if (fastest > 1.10) {
                notes.push(
                    `Every operator is over standard, including the fastest at ${round(fastest, 2)}x. ` +
                    `When nobody can hit the number, that points at the standard being wrong rather ` +
                    `than at any individual.`,
                );
            } else if ((spread ?? 0) > 0.25) {
                notes.push(
                    `Operator ratios span ${spread} between fastest (${round(fastest, 2)}x) and ` +
                    `slowest (${round(slowest, 2)}x) while the fastest is at or near standard, which ` +
                    `points at training or staffing rather than at the standard.`,
                );
            } else {
                notes.push('Operators are performing broadly in line with the standard.');
            }
        }

        return {
            sources: ['epicor'],
            data: { grouped_by: input.group_by, window_days: daysBack, groups: capRows(list, notes) },
            notes,
        };
    },
});

// ---------------------------------------------------------------------------

export const workCenterLoad = defineTool({
    name: 'work_center_load',
    description:
        'Committed hours against available capacity per work centre per week, for open jobs. ' +
        'Use this to see where the plant is over-committed, and to reason about contention ' +
        'between jobs competing for the same work centre.',
    sources: ['epicor', 'ignition', 'xref'],
    schema: z.object({
        dept: z.enum(DEPTS).optional(),
        weeks_ahead: z.number().int().min(1).max(12).default(4),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const weeks = input.weeks_ahead ?? 4;

        const rows = await query(
            `WITH committed AS (
                 SELECT jo.wc_code,
                        date_trunc('week', jh.req_due_date)::date AS week,
                        SUM(jo.est_setup_hrs + jo.est_prod_hrs) AS committed_hrs,
                        COUNT(DISTINCT jo.job_num)::int AS jobs
                 FROM epicor.job_oper jo
                 JOIN epicor.job_head jh ON jh.job_num = jo.job_num
                 JOIN epicor.work_center wc ON wc.wc_code = jo.wc_code
                 WHERE jh.job_closed = FALSE
                   AND jo.act_prod_hrs = 0
                   AND jh.req_due_date BETWEEN $1::date AND $1::date + ($2::int * 7)
                   AND ($3::text IS NULL OR wc.dept = $3)
                 GROUP BY 1, 2
             ),
             downtime AS (
                 SELECT wt.wc_code,
                        SUM(EXTRACT(EPOCH FROM (de.ended_at - de.started_at)) / 3600) AS down_hrs
                 FROM ignition.downtime_event de
                 JOIN xref.wc_tag wt ON de.tag_path LIKE wt.tag_prefix || '/%'
                 WHERE de.started_at >= $1::date - INTERVAL '21 days'
                   AND de.ended_at IS NOT NULL
                   AND de.reason_text !~* '(pm|preventive|scheduled|die change|tooling)'
                 GROUP BY 1
             )
             SELECT c.wc_code, wc.description, wc.dept, c.week::text AS week, c.jobs,
                    ROUND(c.committed_hrs::numeric, 1) AS committed_hrs,
                    ROUND((wc.shifts_per_day * wc.hrs_per_shift * wc.resources * 5)::numeric, 1)
                        AS nameplate_hrs_per_week,
                    ROUND(COALESCE(d.down_hrs, 0)::numeric, 1) AS unplanned_down_hrs_21d
             FROM committed c
             JOIN epicor.work_center wc ON wc.wc_code = c.wc_code
             LEFT JOIN downtime d ON d.wc_code = c.wc_code
             ORDER BY c.week, c.wc_code`,
            [DATASET_TODAY, weeks, input.dept ?? null],
        );

        const list = (rows as Array<Record<string, unknown>>).map((r) => {
            const nameplate = toNum(r.nameplate_hrs_per_week) ?? 0;
            const down = toNum(r.unplanned_down_hrs_21d) ?? 0;
            // Spread the last 21 days of unplanned loss over a weekly rate.
            const weeklyLoss = down / 3;
            const effective = Math.max(0, nameplate - weeklyLoss);
            const committed = toNum(r.committed_hrs) ?? 0;
            return {
                week: r.week,
                wc_code: r.wc_code,
                description: r.description,
                dept: r.dept,
                open_jobs: toNum(r.jobs),
                committed_hrs: committed,
                nameplate_hrs: round(nameplate, 1),
                effective_hrs: round(effective, 1),
                utilization_pct: pct(committed, effective),
                over_committed: committed > effective,
            };
        });

        const over = list.filter((l) => l.over_committed);
        notes.push(
            'Effective capacity discounts nameplate hours by recent unplanned downtime from ' +
            'the Ignition historian. Committed hours are assigned to the week a job is due.',
        );
        if (over.length > 0) {
            notes.push(`${over.length} work centre/week combinations are over-committed.`);
        }

        return {
            sources: ['epicor', 'ignition', 'xref'],
            data: { weeks_ahead: weeks, rows: capRows(list, notes) },
            notes,
        };
    },
});

// ---------------------------------------------------------------------------

export const jobCostSummary = defineTool({
    name: 'job_cost_summary',
    description:
        'Cost roll-up across many jobs: estimated vs actual labour, material, variance, and ' +
        'cost per good casting. Group by part, customer, industry, or month. Use this for ' +
        '"what is this costing us" and margin questions.',
    sources: ['epicor'],
    schema: z.object({
        group_by: z.enum(['part', 'customer', 'industry', 'month']).default('part'),
        part_num: z.string().optional(),
        customer_code: z.string().optional(),
        days_back: z.number().int().min(7).max(600).default(180),
        closed_only: z.boolean().default(true)
            .describe('Restrict to closed jobs, where actual cost is complete'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const daysBack = input.days_back ?? 180;
        const groupBy = input.group_by ?? 'part';
        const closedOnly = input.closed_only ?? true;

        const groupExpr = {
            part: 'part_num',
            customer: 'customer_code',
            industry: 'industry',
            month: "to_char(date_trunc('month', created_at), 'YYYY-MM')",
        }[groupBy];

        // Labour cost is rate-weighted by department, so it is summed in SQL
        // using a CASE rather than applied uniformly afterwards.
        const rateCase = Object.entries(LABOR_RATE_PER_HR)
            .map(([dept, rate]) => `WHEN '${dept}' THEN ${rate}`)
            .join(' ');

        // Roll up to one row per job BEFORE grouping. Joining job_head to
        // job_oper multiplies the header quantity by the operation count, so
        // quantities and material have to be collapsed to job level first.
        const rows = await query(
            `WITH job_labor AS (
                 SELECT jo.job_num,
                        SUM((jo.est_setup_hrs + jo.est_prod_hrs)
                            * (CASE wc.dept ${rateCase} ELSE ${DEFAULT_LABOR_RATE} END)) AS est_labor,
                        SUM((jo.act_setup_hrs + jo.act_prod_hrs)
                            * (CASE wc.dept ${rateCase} ELSE ${DEFAULT_LABOR_RATE} END)) AS act_labor
                 FROM epicor.job_oper jo
                 JOIN epicor.work_center wc ON wc.wc_code = jo.wc_code
                 GROUP BY jo.job_num
             ),
             job_base AS (
                 SELECT jh.job_num, jh.part_num, p.customer_code, p.industry,
                        jh.created_at, jh.qty_ordered, jh.qty_completed,
                        jh.qty_ordered * p.target_wt_lbs * ${ALUMINUM_COST_PER_LB} AS material,
                        COALESCE(jl.est_labor, 0) AS est_labor,
                        COALESCE(jl.act_labor, 0) AS act_labor
                 FROM epicor.job_head jh
                 JOIN epicor.part p ON p.part_num = jh.part_num
                 LEFT JOIN job_labor jl ON jl.job_num = jh.job_num
                 WHERE jh.created_at >= $1::date - ($2 || ' days')::interval
                   AND ($3::bool = FALSE OR jh.job_closed = TRUE)
                   AND ($4::text IS NULL OR jh.part_num = $4)
                   AND ($5::text IS NULL OR p.customer_code = $5)
             )
             SELECT ${groupExpr} AS group_key,
                    COUNT(*)::int              AS jobs,
                    SUM(qty_ordered)::int      AS qty_ordered,
                    SUM(qty_completed)::int    AS qty_completed,
                    ROUND(SUM(est_labor)::numeric, 2) AS est_labor_usd,
                    ROUND(SUM(act_labor)::numeric, 2) AS act_labor_usd,
                    ROUND(SUM(material)::numeric, 2)  AS material_usd
             FROM job_base
             GROUP BY 1 ORDER BY act_labor_usd DESC NULLS LAST`,
            [
                DATASET_TODAY, daysBack, closedOnly,
                input.part_num ?? null, input.customer_code ?? null,
            ],
        );

        const list = (rows as Array<Record<string, unknown>>).map((r) => {
            const est = toNum(r.est_labor_usd) ?? 0;
            const act = toNum(r.act_labor_usd) ?? 0;
            const mat = toNum(r.material_usd) ?? 0;
            const good = toNum(r.qty_completed) ?? 0;
            return {
                [groupBy]: r.group_key,
                jobs: toNum(r.jobs),
                qty_ordered: toNum(r.qty_ordered),
                qty_completed: good,
                est_labor_usd: round(est),
                act_labor_usd: round(act),
                labor_variance_usd: round(act - est),
                labor_variance_pct: est > 0 ? round(((act - est) / est) * 100, 1) : null,
                material_usd: round(mat),
                total_cost_usd: round(act + mat),
                cost_per_good_casting_usd: good > 0 ? round((act + mat) / good) : null,
            };
        });

        notes.push('Labour and material rates are nominal, not plant actuals (see docs/DATA.md).');
        if (list.length === 0) notes.push('No jobs match those filters in that window.');

        return {
            sources: ['epicor'],
            data: { grouped_by: groupBy, window_days: daysBack, groups: capRows(list, notes) },
            notes,
        };
    },
});
