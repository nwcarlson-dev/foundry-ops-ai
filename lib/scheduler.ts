/**
 * Deterministic finite-capacity scheduler.
 *
 * No model is involved in the scheduling decision. This is a dispatch rule —
 * earliest due date, with setup-family grouping to avoid needless changeovers,
 * against real work-centre capacity discounted by recent unplanned downtime.
 * Same inputs always produce the same schedule.
 *
 * The LLM's only job downstream is to explain the result in plain English:
 * what fitted, what did not, and what it would take. Being explicit about that
 * boundary is the point — a plant should not be asked to trust a language model
 * with a capacity decision, and it does not have to.
 *
 * What it does NOT model, stated plainly because a scheduler that hides its
 * assumptions is worse than none:
 *   - operator availability by skill (only work-centre capacity)
 *   - operation precedence across work centres (each centre is sequenced alone)
 *   - material or tooling availability
 *   - queue and move time between operations
 */
import { query } from './db';
import { DATASET_TODAY } from './dataset';

export interface Segment {
    day: number;              // 0-4, Monday..Friday
    job_num: string;
    part_num: string;
    oper_seq: number;
    hours: number;
    /** True when this segment paid a setup because the family changed. */
    changeover: boolean;
    family: string;
    due_date: string;
    /** Scheduled to finish after the job is due. */
    late: boolean;
}

export interface WorkCentreSchedule {
    wc_code: string;
    description: string;
    dept: string;
    capacity_per_day: number;
    /** Nameplate minus the downtime discount actually applied. */
    effective_per_day: number;
    downtime_discount_pct: number;
    segments: Segment[];
    hours_scheduled: number;
    utilization_pct: number;
    /** Setups actually paid: a family change between consecutive operations. */
    changeovers: number;
    /**
     * Setups skipped because consecutive operations shared a family. This is the
     * number that matters — it is time not spent on tooling — and it counts
     * whether the grouping rule had to resequence anything or whether due-date
     * order produced it for free.
     */
    setups_saved: number;
    /** Times the grouping rule pulled an operation forward out of due order. */
    resequenced: number;
}

export interface Unscheduled {
    job_num: string;
    part_num: string;
    oper_seq: number;
    wc_code: string;
    hours_needed: number;
    due_date: string;
    reason: string;
}

export interface Schedule {
    week_start: string;
    days: string[];
    dept: string | null;
    work_centres: WorkCentreSchedule[];
    unscheduled: Unscheduled[];
    totals: {
        hours_scheduled: number;
        hours_unscheduled: number;
        operations_scheduled: number;
        operations_unscheduled: number;
        late_operations: number;
        overtime_hours_needed: number;
    };
    assumptions: string[];
}

interface PendingOp {
    job_num: string;
    part_num: string;
    oper_seq: number;
    wc_code: string;
    setup_hrs: number;
    prod_hrs: number;
    due_date: string;
    family: string;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Allocation arithmetic rounds to 2dp, not 1dp.
 *
 * The recorded segment hours and the capacity deducted for them must be the
 * SAME number — rounding the record to 1dp while deducting the unrendered value
 * let accumulated error push a day's allocation past its capacity, which is the
 * one thing this scheduler must never do. Display rounds to 1dp at the edge.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Monday of the week containing `from`. */
export function weekStart(from: string): string {
    const d = new Date(`${from}T00:00:00Z`);
    const dow = d.getUTCDay();                 // 0 Sun .. 6 Sat
    const delta = dow === 0 ? -6 : 1 - dow;    // back to Monday
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
}

const addDays = (iso: string, n: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};

export async function buildSchedule(
    options: { week_start?: string; dept?: string } = {},
): Promise<Schedule> {
    const start = weekStart(options.week_start ?? DATASET_TODAY);
    const days = [0, 1, 2, 3, 4].map((i) => addDays(start, i));
    const dept = options.dept ?? null;

    // --- inputs ------------------------------------------------------------
    // Operations on open jobs that have not started. Setup family is the
    // pattern: two jobs off the same pattern need no tooling change between
    // them, which is the changeover this scheduler is trying to avoid.
    const opRows = await query(
        `SELECT jo.job_num, jh.part_num, jo.oper_seq, jo.wc_code,
                jo.est_setup_hrs, jo.est_prod_hrs,
                jh.req_due_date::text AS due_date,
                p.pattern_num || '/' || p.alloy AS family
         FROM epicor.job_oper jo
         JOIN epicor.job_head jh ON jh.job_num = jo.job_num
         JOIN epicor.part p     ON p.part_num  = jh.part_num
         JOIN epicor.work_center wc ON wc.wc_code = jo.wc_code
         WHERE jh.job_closed = FALSE
           AND jo.act_prod_hrs = 0
           AND ($1::text IS NULL OR wc.dept = $1)
         ORDER BY jh.req_due_date, jo.job_num, jo.oper_seq`,
        [dept],
    );

    const centreRows = await query(
        `WITH downtime AS (
             SELECT wt.wc_code,
                    SUM(EXTRACT(EPOCH FROM (de.ended_at - de.started_at)) / 3600) AS down_hrs
             FROM ignition.downtime_event de
             JOIN xref.wc_tag wt ON de.tag_path LIKE wt.tag_prefix || '/%'
             WHERE de.started_at >= $1::date - INTERVAL '21 days'
               AND de.ended_at IS NOT NULL
               AND de.reason_text !~* '(pm|preventive|scheduled|die change|tooling)'
             GROUP BY 1
         )
         SELECT wc.wc_code, wc.description, wc.dept,
                (wc.shifts_per_day * wc.hrs_per_shift * wc.resources) AS capacity_per_day,
                COALESCE(d.down_hrs, 0) AS down_hrs_21d
         FROM epicor.work_center wc
         LEFT JOIN downtime d ON d.wc_code = wc.wc_code
         WHERE ($2::text IS NULL OR wc.dept = $2)
         ORDER BY wc.wc_code`,
        [DATASET_TODAY, dept],
    );

    const ops: PendingOp[] = (opRows as Array<Record<string, unknown>>).map((r) => ({
        job_num: String(r.job_num),
        part_num: String(r.part_num),
        oper_seq: num(r.oper_seq),
        wc_code: String(r.wc_code),
        setup_hrs: num(r.est_setup_hrs),
        prod_hrs: num(r.est_prod_hrs),
        due_date: String(r.due_date),
        family: String(r.family),
    }));

    const byCentre = new Map<string, PendingOp[]>();
    for (const op of ops) {
        byCentre.set(op.wc_code, [...(byCentre.get(op.wc_code) ?? []), op]);
    }

    const workCentres: WorkCentreSchedule[] = [];
    const unscheduled: Unscheduled[] = [];

    for (const c of centreRows as Array<Record<string, unknown>>) {
        const wcCode = String(c.wc_code);
        const queue = byCentre.get(wcCode) ?? [];
        const nameplate = num(c.capacity_per_day);

        // Recent unplanned downtime as a share of the last three working weeks
        // of nameplate capacity, capped so one catastrophic week does not zero
        // the centre out entirely.
        const nameplate21d = nameplate * 15;
        const discount = nameplate21d > 0
            ? Math.min(0.6, num(c.down_hrs_21d) / nameplate21d)
            : 0;
        const effective = r1(nameplate * (1 - discount));

        const remaining = [0, 1, 2, 3, 4].map(() => r2(effective));
        const segments: Segment[] = [];
        let changeovers = 0;
        let setupsSaved = 0;
        let resequenced = 0;

        // --- the dispatch rule ---------------------------------------------
        // Earliest due date first. Before taking it, look for an operation from
        // the family already set up on the machine whose due date is within
        // GROUPING_WINDOW_DAYS of the most urgent one — running it now saves a
        // full setup, and the tolerance is what stops that saving from starving
        // an urgent job just because a convenient one shares tooling.
        const GROUPING_WINDOW_DAYS = 4;
        const pending = [...queue].sort(
            (a, b) => a.due_date.localeCompare(b.due_date) || a.job_num.localeCompare(b.job_num),
        );
        const dayDiff = (a: string, b: string) =>
            (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

        let lastFamily: string | null = null;
        let day = 0;

        while (pending.length > 0) {
            // Advance past any full days.
            while (day < 5 && remaining[day] <= 0.01) day++;
            if (day >= 5) break;

            let pick = 0;
            if (lastFamily !== null) {
                const sameFamily = pending.findIndex(
                    (o) => o.family === lastFamily
                        && dayDiff(o.due_date, pending[0].due_date) <= GROUPING_WINDOW_DAYS,
                );
                if (sameFamily > 0) {
                    pick = sameFamily;
                    resequenced++;
                }
            }

            const op = pending.splice(pick, 1)[0];
            // Counters are incremented only after the operation is actually
            // placed — an op that gets rolled back as unscheduled never happened
            // on the machine, so it cannot have caused or saved a setup.
            const setup = op.family === lastFamily ? 0 : op.setup_hrs;
            const isTransition = lastFamily !== null;

            let need = r2(setup + op.prod_hrs);
            const placed: Array<{ day: number; hours: number }> = [];

            // Operations may span days: a 20-hour op on a 16-hour centre runs
            // into tomorrow rather than being declared impossible.
            let cursor = day;
            while (need > 0.01 && cursor < 5) {
                const take = r2(Math.min(need, remaining[cursor]));
                if (take > 0.01) {
                    remaining[cursor] = r2(remaining[cursor] - take);
                    placed.push({ day: cursor, hours: take });
                    need = r2(need - take);
                }
                if (need > 0.01) cursor++;
            }

            if (need > 0.01) {
                // Did not fit in the week. Roll back so the schedule never shows
                // partially-committed work that cannot actually be finished.
                for (const p of placed) remaining[p.day] = r2(remaining[p.day] + p.hours);
                unscheduled.push({
                    job_num: op.job_num,
                    part_num: op.part_num,
                    oper_seq: op.oper_seq,
                    wc_code: wcCode,
                    hours_needed: r1(setup + op.prod_hrs),
                    due_date: op.due_date,
                    reason:
                        `${wcCode} has no remaining capacity this week — ` +
                        `${r1(setup + op.prod_hrs)} hrs needed, ` +
                        `${r1(remaining.reduce((s, h) => s + h, 0))} hrs free across the week.`,
                });
                continue;
            }

            if (isTransition) {
                if (setup > 0) changeovers++;
                else setupsSaved++;
            }

            const finishesOn = days[placed[placed.length - 1].day];
            for (const p of placed) {
                segments.push({
                    day: p.day,
                    job_num: op.job_num,
                    part_num: op.part_num,
                    oper_seq: op.oper_seq,
                    hours: p.hours,
                    changeover: setup > 0 && p.day === placed[0].day,
                    family: op.family,
                    due_date: op.due_date,
                    late: finishesOn > op.due_date,
                });
            }

            lastFamily = op.family;
            day = cursor;
        }

        // Anything still queued when the week ran out.
        for (const op of pending) {
            unscheduled.push({
                job_num: op.job_num,
                part_num: op.part_num,
                oper_seq: op.oper_seq,
                wc_code: wcCode,
                hours_needed: r1(op.setup_hrs + op.prod_hrs),
                due_date: op.due_date,
                reason: `${wcCode} is fully committed for the week before this operation is reached.`,
            });
        }

        const scheduled = r1(segments.reduce((s, x) => s + x.hours, 0));
        workCentres.push({
            wc_code: wcCode,
            description: String(c.description),
            dept: String(c.dept),
            capacity_per_day: nameplate,
            effective_per_day: effective,
            downtime_discount_pct: r1(discount * 100),
            segments,
            hours_scheduled: scheduled,
            utilization_pct: effective > 0 ? r1((scheduled / (effective * 5)) * 100) : 0,
            changeovers,
            setups_saved: setupsSaved,
            resequenced,
        });
    }

    const active = workCentres.filter((w) => w.segments.length > 0 || w.hours_scheduled > 0);
    const hoursUnscheduled = r1(unscheduled.reduce((s, u) => s + u.hours_needed, 0));

    return {
        week_start: start,
        days,
        dept,
        work_centres: active.length > 0 ? active : workCentres,
        unscheduled: unscheduled.sort((a, b) => a.due_date.localeCompare(b.due_date)),
        totals: {
            hours_scheduled: r1(workCentres.reduce((s, w) => s + w.hours_scheduled, 0)),
            hours_unscheduled: hoursUnscheduled,
            operations_scheduled: workCentres.reduce(
                (s, w) => s + new Set(w.segments.map((x) => `${x.job_num}:${x.oper_seq}`)).size, 0,
            ),
            operations_unscheduled: unscheduled.length,
            late_operations: workCentres.reduce(
                (s, w) => s + new Set(
                    w.segments.filter((x) => x.late).map((x) => `${x.job_num}:${x.oper_seq}`),
                ).size, 0,
            ),
            overtime_hours_needed: hoursUnscheduled,
        },
        assumptions: [
            'Earliest due date first, with setup-family grouping inside a three-day due bucket.',
            'Capacity is shifts x hours x resources per work centre, discounted by unplanned downtime logged in the Ignition historian over the last 21 days (capped at 60%).',
            'Operations may span days but are never split across work centres.',
            'Operator availability by skill, cross-centre operation precedence, material and tooling availability, and queue/move time are NOT modelled.',
        ],
    };
}
