/**
 * Job-oriented tools: what is open, what one job looks like in detail, and what
 * is at risk of missing its date.
 */
import { z } from 'zod';
import { query, queryOne } from '../db';
import { DATASET_TODAY, LABOR_RATE_PER_HR, DEFAULT_LABOR_RATE, ALUMINUM_COST_PER_LB } from '../dataset';
import { defineTool, capRows, round, toNum, pct, type ToolResult } from './types';

// ---------------------------------------------------------------------------

export const getOpenJobs = defineTool({
    name: 'get_open_jobs',
    description:
        'List open (unclosed) Epicor jobs, optionally filtered by department, work center, ' +
        'part number, customer, or how soon they are due. Use this to answer "what is on the ' +
        'floor" or "what is running in molding". For due-date risk specifically, prefer ' +
        'at_risk_jobs, which also accounts for machine availability.',
    sources: ['epicor'],
    schema: z.object({
        dept: z.enum(['MELT', 'MOLD', 'CORE', 'CLEAN', 'HEAT_TREAT', 'MACHINE']).optional()
            .describe('Only jobs routed through this department'),
        wc_code: z.string().optional().describe('Only jobs routed through this work center, e.g. MOLD-L2'),
        part_num: z.string().optional().describe('Exact Epicor part number, e.g. 4471-BRKT'),
        customer_code: z.string().optional().describe('Epicor customer code, e.g. DEERE'),
        due_within_days: z.number().int().min(0).max(180).optional()
            .describe('Only jobs due within this many days of the current dataset date'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const rows = await query(
            `SELECT DISTINCT
                 jh.job_num, jh.part_num, p.description, p.customer_code, p.process,
                 jh.qty_ordered, jh.qty_completed,
                 jh.req_due_date::text AS req_due_date,
                 (jh.req_due_date - $1::date) AS days_to_due
             FROM epicor.job_head jh
             JOIN epicor.part p ON p.part_num = jh.part_num
             JOIN epicor.job_oper jo ON jo.job_num = jh.job_num
             JOIN epicor.work_center wc ON wc.wc_code = jo.wc_code
             WHERE jh.job_closed = FALSE
               AND ($2::text IS NULL OR wc.dept = $2)
               AND ($3::text IS NULL OR jo.wc_code = $3)
               AND ($4::text IS NULL OR jh.part_num = $4)
               AND ($5::text IS NULL OR p.customer_code = $5)
               AND ($6::int  IS NULL OR jh.req_due_date <= $1::date + $6)
             ORDER BY days_to_due, jh.job_num`,
            [
                DATASET_TODAY,
                input.dept ?? null,
                input.wc_code ?? null,
                input.part_num ?? null,
                input.customer_code ?? null,
                input.due_within_days ?? null,
            ],
        );

        if (rows.length === 0) notes.push('No open jobs match those filters.');
        return { sources: ['epicor'], data: capRows(rows, notes), notes };
    },
});

// ---------------------------------------------------------------------------

export const getJobDetail = defineTool({
    name: 'get_job_detail',
    description:
        'Full Epicor detail for one job: every operation with estimated vs actual hours, ' +
        'scrap broken out by reason code, labor by shift, and a cost roll-up. Start here when ' +
        'the user names a specific job.',
    sources: ['epicor'],
    schema: z.object({
        job_num: z.string().describe('Epicor job number, e.g. J-100864. Accepts 100864 or J100864 too.'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];

        // Accept whatever form the user typed, the same way the monday bridge
        // does — a supervisor should not have to punctuate a job number.
        const normalized = await queryOne<{ job_num: string | null }>(
            `SELECT xref.normalize_job_ref($1) AS job_num`, [input.job_num],
        );
        const jobNum = normalized?.job_num ?? input.job_num;

        const header = await queryOne(
            `SELECT jh.job_num, jh.part_num, p.description, p.alloy, p.process,
                    p.customer_code, p.industry, p.target_wt_lbs, p.cavities,
                    jh.qty_ordered, jh.qty_completed, jh.job_closed,
                    jh.req_due_date::text AS req_due_date,
                    (jh.req_due_date - $2::date) AS days_to_due,
                    jh.created_at::text AS created_at
             FROM epicor.job_head jh
             JOIN epicor.part p ON p.part_num = jh.part_num
             WHERE jh.job_num = $1`,
            [jobNum, DATASET_TODAY],
        );

        if (!header) {
            return {
                sources: ['epicor'],
                data: null,
                notes: [`No job ${jobNum} exists in Epicor.`],
            };
        }

        const operations = await query(
            `SELECT jo.oper_seq, jo.wc_code, wc.description AS wc_description, wc.dept,
                    jo.est_setup_hrs, jo.est_prod_hrs, jo.act_setup_hrs, jo.act_prod_hrs,
                    jo.qty_completed, jo.scrap_qty,
                    (jo.act_prod_hrs = 0) AS not_started
             FROM epicor.job_oper jo
             JOIN epicor.work_center wc ON wc.wc_code = jo.wc_code
             WHERE jo.job_num = $1 ORDER BY jo.oper_seq`,
            [jobNum],
        );

        const scrap = await query(
            `SELECT sd.reason_code, sr.description, sr.category, SUM(sd.scrap_qty)::int AS qty
             FROM epicor.scrap_dtl sd
             JOIN epicor.scrap_reason sr ON sr.reason_code = sd.reason_code
             WHERE sd.job_num = $1
             GROUP BY 1, 2, 3 ORDER BY qty DESC`,
            [jobNum],
        );

        const labor = await query(
            `SELECT ld.shift, COUNT(DISTINCT ld.employee_num)::int AS operators,
                    ROUND(SUM(ld.labor_hrs)::numeric, 1) AS labor_hrs
             FROM epicor.labor_dtl ld WHERE ld.job_num = $1
             GROUP BY 1 ORDER BY 1`,
            [jobNum],
        );

        // Cost roll-up. Rates are nominal — see docs/DATA.md.
        const ops = operations as Array<Record<string, unknown>>;
        let estLabor = 0;
        let actLabor = 0;
        for (const op of ops) {
            const rate = LABOR_RATE_PER_HR[String(op.dept)] ?? DEFAULT_LABOR_RATE;
            estLabor += ((toNum(op.est_setup_hrs) ?? 0) + (toNum(op.est_prod_hrs) ?? 0)) * rate;
            actLabor += ((toNum(op.act_setup_hrs) ?? 0) + (toNum(op.act_prod_hrs) ?? 0)) * rate;
        }

        const h = header as Record<string, unknown>;
        const qtyOrdered = toNum(h.qty_ordered) ?? 0;
        const qtyCompleted = toNum(h.qty_completed) ?? 0;
        const weight = toNum(h.target_wt_lbs) ?? 0;
        const material = qtyOrdered * weight * ALUMINUM_COST_PER_LB;
        const totalScrap = (scrap as Array<Record<string, unknown>>)
            .reduce((sum, r) => sum + (toNum(r.qty) ?? 0), 0);

        notes.push('Labor and material rates are nominal, not LeClaire actuals (see docs/DATA.md).');
        if (ops.some((o) => o.not_started)) {
            notes.push('Operations with zero actual hours have not reached the floor yet.');
        }

        return {
            sources: ['epicor'],
            data: {
                header,
                operations,
                scrap_by_reason: scrap,
                scrap_total: totalScrap,
                scrap_pct_of_ordered: pct(totalScrap, qtyOrdered),
                labor_by_shift: labor,
                cost: {
                    est_labor_usd: round(estLabor),
                    act_labor_usd: round(actLabor),
                    labor_variance_usd: round(actLabor - estLabor),
                    material_usd: round(material),
                    total_actual_usd: round(actLabor + material),
                    cost_per_good_casting_usd:
                        qtyCompleted > 0 ? round((actLabor + material) / qtyCompleted) : null,
                },
            },
            notes,
        };
    },
});

// ---------------------------------------------------------------------------

export const atRiskJobs = defineTool({
    name: 'at_risk_jobs',
    description:
        'Open jobs likely to miss their due date. Compares remaining estimated hours against ' +
        'the working time left before the due date at the job\'s bottleneck work center, and ' +
        'discounts that capacity by the work center\'s recent unplanned downtime from the ' +
        'Ignition historian. Use this for "what is going to be late and why".',
    sources: ['epicor', 'ignition', 'xref'],
    schema: z.object({
        dept: z.enum(['MELT', 'MOLD', 'CORE', 'CLEAN', 'HEAT_TREAT', 'MACHINE']).optional()
            .describe('Restrict to jobs routed through this department'),
        horizon_days: z.number().int().min(1).max(120).default(30)
            .describe('Only consider jobs due within this many days'),
    }),
    async run(input): Promise<ToolResult> {
        const notes: string[] = [];
        const horizon = input.horizon_days ?? 30;

        const rows = await query(
            `WITH remaining AS (
                 -- Hours still to be worked, per job per work center.
                 SELECT jo.job_num, jo.wc_code,
                        SUM(jo.est_setup_hrs + jo.est_prod_hrs) AS rem_hrs
                 FROM epicor.job_oper jo
                 JOIN epicor.job_head jh ON jh.job_num = jo.job_num
                 WHERE jh.job_closed = FALSE AND jo.act_prod_hrs = 0
                 GROUP BY 1, 2
             ),
             per_job AS (
                 SELECT job_num,
                        SUM(rem_hrs) AS total_rem_hrs,
                        (array_agg(wc_code ORDER BY rem_hrs DESC))[1] AS bottleneck_wc,
                        MAX(rem_hrs) AS bottleneck_hrs
                 FROM remaining GROUP BY 1
             ),
             downtime AS (
                 -- Unplanned availability loss over the last 21 days, per work
                 -- center, reached through the Ignition tag bridge. A work
                 -- center that has been breaking down cannot be planned at its
                 -- nameplate capacity.
                 SELECT wt.wc_code,
                        SUM(EXTRACT(EPOCH FROM (de.ended_at - de.started_at)) / 3600) AS down_hrs
                 FROM ignition.downtime_event de
                 JOIN xref.wc_tag wt ON de.tag_path LIKE wt.tag_prefix || '/%'
                 WHERE de.started_at >= $1::date - INTERVAL '21 days'
                   AND de.ended_at IS NOT NULL
                   AND de.reason_text !~* '(pm|preventive|scheduled|die change|tooling)'
                 GROUP BY 1
             )
             SELECT jh.job_num, jh.part_num, p.description, p.customer_code,
                    jh.qty_ordered, jh.qty_completed,
                    jh.req_due_date::text AS req_due_date,
                    (jh.req_due_date - $1::date) AS days_to_due,
                    ROUND(pj.total_rem_hrs::numeric, 1) AS remaining_est_hrs,
                    ROUND(pj.bottleneck_hrs::numeric, 1) AS bottleneck_hrs,
                    pj.bottleneck_wc,
                    (wc.shifts_per_day * wc.hrs_per_shift * wc.resources) AS bottleneck_hrs_per_day,
                    (SELECT COUNT(*) FROM generate_series(
                         $1::date, GREATEST(jh.req_due_date, $1::date), INTERVAL '1 day') d
                      WHERE EXTRACT(ISODOW FROM d) < 6)::int AS working_days_left,
                    ROUND(COALESCE(dt.down_hrs, 0)::numeric, 1) AS unplanned_down_hrs_21d
             FROM epicor.job_head jh
             JOIN epicor.part p ON p.part_num = jh.part_num
             JOIN per_job pj ON pj.job_num = jh.job_num
             JOIN epicor.work_center wc ON wc.wc_code = pj.bottleneck_wc
             LEFT JOIN downtime dt ON dt.wc_code = pj.bottleneck_wc
             WHERE jh.job_closed = FALSE
               AND jh.req_due_date <= $1::date + $2::int
               AND ($3::text IS NULL OR wc.dept = $3)
             ORDER BY days_to_due`,
            [DATASET_TODAY, horizon, input.dept ?? null],
        );

        // Risk is computed here rather than in SQL so the arithmetic is legible
        // and testable, and so each verdict can explain itself.
        //
        // Critically, jobs are assessed against CONTENDED capacity, not in
        // isolation. Five jobs can each individually fit inside a work centre's
        // remaining hours and still be collectively impossible, which is exactly
        // what a breakdown on a shared cell produces. Judging each job alone
        // reports "all on track" right up until the week everything is late.
        //
        // Allocation is earliest-due-first at each bottleneck: for a given job,
        // the capacity it can actually count on is what remains after every job
        // due before it has taken its share.
        const base = (rows as Array<Record<string, unknown>>).map((r) => {
            const hrsPerDay = toNum(r.bottleneck_hrs_per_day) ?? 0;
            const downHrs = toNum(r.unplanned_down_hrs_21d) ?? 0;
            // Recent unplanned downtime, as a fraction of the last 21 days of
            // nameplate capacity, discounts the capacity available ahead.
            const nameplate21d = hrsPerDay * 15;      // ~15 working days in 21
            const lossFactor = nameplate21d > 0 ? Math.min(0.6, downHrs / nameplate21d) : 0;
            const workingDays = toNum(r.working_days_left) ?? 0;

            return {
                row: r,
                wc: String(r.bottleneck_wc),
                daysToDue: toNum(r.days_to_due) ?? 0,
                remHrs: toNum(r.remaining_est_hrs) ?? 0,
                wcHrs: toNum(r.bottleneck_hrs) ?? 0,
                hrsPerDay,
                downHrs,
                lossFactor,
                capacityToDue: hrsPerDay * workingDays * (1 - lossFactor),
                workingDays,
            };
        });

        // Cumulative demand at each bottleneck, earliest due date first.
        const queued = new Map<string, number>();
        const assessed = [...base]
            .sort((a, b) => a.daysToDue - b.daysToDue)
            .map((j) => {
                const ahead = queued.get(j.wc) ?? 0;
                const cumulative = ahead + j.wcHrs;
                queued.set(j.wc, cumulative);

                const r = j.row;
                let verdict: string;
                let why: string;

                if (j.daysToDue < 0) {
                    verdict = 'LATE';
                    why = `Due date passed ${Math.abs(j.daysToDue)} days ago with ${j.remHrs} hrs still to run.`;
                } else if (cumulative > j.capacityToDue) {
                    verdict = 'AT_RISK';
                    const contended = ahead > 0;
                    why =
                        `${j.wc} has ~${round(j.capacityToDue, 1)} hrs of capacity before this due date` +
                        (j.lossFactor > 0.05
                            ? ` (after discounting ${j.downHrs} hrs of unplanned downtime logged there in the last 21 days)`
                            : '') +
                        `, but ${round(cumulative, 1)} hrs of work are queued ahead of or including this job` +
                        (contended
                            ? ` — ${round(ahead, 1)} hrs of that belongs to jobs due sooner.`
                            : `.`);
                } else {
                    verdict = 'ON_TRACK';
                    why =
                        `${round(cumulative, 1)} hrs queued at ${j.wc} against ` +
                        `~${round(j.capacityToDue, 1)} hrs available before the due date.`;
                }

                return {
                    job_num: r.job_num,
                    part_num: r.part_num,
                    description: r.description,
                    customer_code: r.customer_code,
                    req_due_date: r.req_due_date,
                    days_to_due: j.daysToDue,
                    qty_ordered: r.qty_ordered,
                    qty_completed: r.qty_completed,
                    remaining_est_hrs: j.remHrs,
                    bottleneck_wc: j.wc,
                    hrs_at_bottleneck: j.wcHrs,
                    hrs_queued_ahead: round(ahead, 1),
                    capacity_before_due: round(j.capacityToDue, 1),
                    unplanned_down_hrs_21d: j.downHrs,
                    capacity_loss_pct: round(j.lossFactor * 100, 1),
                    verdict,
                    why,
                };
            });

        const flagged = assessed.filter((a) => a.verdict !== 'ON_TRACK');
        notes.push(
            'Jobs are assessed against contended capacity: work is allocated at each ' +
            'bottleneck work centre earliest-due-date first, so a job can be at risk because ' +
            'of what is queued ahead of it rather than its own size. Capacity is discounted ' +
            'by recent unplanned downtime from the Ignition historian.',
        );
        if (flagged.length === 0) {
            notes.push(`No open jobs are at risk within ${horizon} days.`);
        }

        // Return every assessed job, flagged ones first. Returning only the
        // flagged jobs would hide the queue that explains them — a job is often
        // at risk because of what is sitting ahead of it, and that context is
        // the answer, not noise.
        const RANK: Record<string, number> = { LATE: 0, AT_RISK: 1, ON_TRACK: 2 };
        const ordered = [...assessed].sort(
            (a, b) => RANK[a.verdict] - RANK[b.verdict] || a.days_to_due - b.days_to_due,
        );

        return {
            sources: ['epicor', 'ignition', 'xref'],
            data: {
                assessed_jobs: assessed.length,
                at_risk_or_late: flagged.length,
                jobs: capRows(ordered, notes),
            },
            notes,
        };
    },
});
