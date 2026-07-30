/**
 * Seeded synthetic data generator for the Foundry Ops Copilot.
 *
 * Everything here is reproducible from a fixed seed: `npm run seed` twice gives
 * byte-identical data. The data is synthetic on purpose and documented as such
 * in docs/DATA.md — including the five signals planted in it.
 *
 * The important property is that the planted signals are *split across source
 * systems*. None of them can be found inside a single schema. That is the whole
 * thesis of the project, so the generator enforces it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';

import { Rng } from './lib/rng';
import { connect, bulkInsert, ts, dateOnly } from './lib/db';
import {
    DATASET_TODAY, DATASET_START, SEED,
    SCRAP_REASONS, EPICOR_TO_THRIVE_DEFECT,
    WORK_CENTERS, PARTS, ORPHAN_THRIVE_PATTERN,
    IGNITION_TAGS, WC_TAG_MAP,
    VETERAN_EMPLOYEES, NEW_HIRE_EMPLOYEES, MONDAY_CUSTOMERS, CUSTOMER_DISPLAY,
    type PartDef,
} from '../lib/domain';

// npm scripts run from the package root.
const root = process.cwd();
loadEnv({ path: join(root, '.env.local'), quiet: true });
loadEnv({ path: join(root, '.env'), quiet: true });

const rng = new Rng(SEED);

const DAY_MS = 86_400_000;
const TOTAL_DAYS = Math.round(
    (DATASET_TODAY.getTime() - DATASET_START.getTime()) / DAY_MS,
);

// --- Planted-signal windows, as day offsets from DATASET_START -------------
const DEGAS_DECAY_START = TOTAL_DAYS - 56;   // signal 1: last 8 weeks
const NEW_HIRE_START    = 380;               // signal 2
const DOWNTIME_CLUSTER  = TOTAL_DAYS - 21;   // signal 4: last 3 weeks
const OPEN_JOB_WINDOW   = 35;                // jobs newer than this are still open

const addDays = (base: Date, days: number) => new Date(base.getTime() + days * DAY_MS);
const dayOf = (d: Date) => Math.floor((d.getTime() - DATASET_START.getTime()) / DAY_MS);
const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

const DEGAS_BASELINE_MIN = 12.0;
const DEGAS_FLOOR_MIN = 6.0;

/**
 * The underlying (noise-free) degas setpoint on a furnace for a given day.
 *
 * Furnace 3 drifts 12.0 -> 6.0 minutes across the final 8 weeks. Nobody changed
 * a setpoint; the cycle timer drifted and no one noticed. Kept deterministic and
 * separate from sampling so that both the Thrive heat record and the Ignition
 * historian tag are independent *measurements of the same process*, and so the
 * scrap model can be driven by the real deficit rather than by a coincidence.
 */
function degasSetpoint(furnaceId: string, day: number): number {
    if (furnaceId !== 'FURN-3' || day < DEGAS_DECAY_START) return DEGAS_BASELINE_MIN;
    const progress = (day - DEGAS_DECAY_START) / (TOTAL_DAYS - DEGAS_DECAY_START);
    return DEGAS_BASELINE_MIN - (DEGAS_BASELINE_MIN - DEGAS_FLOOR_MIN) * progress;
}

/** A single observed degas time: the setpoint plus measurement noise. */
function degasMinutesFor(furnaceId: string, day: number): number {
    return Math.max(4, rng.normal(degasSetpoint(furnaceId, day), 0.8));
}

/**
 * How far degassing has fallen short, normalized 0 (healthy) .. 1 (fully
 * decayed). Drives the extra gas-porosity scrap below.
 */
function degasDeficit(furnaceId: string, day: number): number {
    const shortfall = DEGAS_BASELINE_MIN - degasSetpoint(furnaceId, day);
    return Math.max(0, shortfall / (DEGAS_BASELINE_MIN - DEGAS_FLOOR_MIN));
}

/**
 * Susceptibility to gas porosity, by part.
 *
 * Under-degassed metal leaves dissolved hydrogen in every casting poured from
 * that furnace — so this is deliberately NOT limited to one part number. It
 * shows up worst on the heavy-section sand brackets and mildest on thin-wall
 * permanent mold work, which is the physically honest version and makes the
 * finding richer: it is a furnace problem, not a part problem.
 */
function porositySusceptibility(part: PartDef): number {
    if (part.part_num === '4471-BRKT' || part.part_num === '4482-BRKT') return 1.0;
    if (part.alloy !== 'A356') return 0;          // only the A356 furnace drifted
    return part.process === 'SAND' ? 0.55 : 0.30;
}

async function main() {
    const client = await connect();
    console.log('connected\n');

    // ---- schema ----------------------------------------------------------
    console.log('applying db/schema.sql');
    await client.query(readFileSync(join(root, 'db', 'schema.sql'), 'utf8'));
    console.log('applying db/xref.sql');
    await client.query(readFileSync(join(root, 'db', 'xref.sql'), 'utf8'));
    // Usage counters live in their own schema and are NOT dropped: the spend
    // ceiling must survive a reseed.
    console.log('applying db/limits.sql');
    await client.query(readFileSync(join(root, 'db', 'limits.sql'), 'utf8'));
    console.log('');

    const counts: Record<string, number> = {};
    const record = async (
        label: string, table: string, cols: string[], rows: unknown[][],
    ) => {
        counts[label] = await bulkInsert(client, table, cols, rows);
        console.log(`  ${label.padEnd(28)} ${String(counts[label]).padStart(7)}`);
    };

    console.log('generating');

    // ---- reference data --------------------------------------------------
    await record('epicor.scrap_reason', 'epicor.scrap_reason',
        ['reason_code', 'description', 'category'],
        SCRAP_REASONS.map((r) => [...r]));

    await record('epicor.work_center', 'epicor.work_center',
        ['wc_code', 'description', 'dept', 'shifts_per_day', 'hrs_per_shift', 'resources', 'queue_hrs'],
        WORK_CENTERS.map((w) => [w.wc_code, w.description, w.dept, w.shifts_per_day, w.hrs_per_shift, w.resources, w.queue_hrs]));

    await record('epicor.part', 'epicor.part',
        ['part_num', 'description', 'alloy', 'process', 'pattern_num', 'cavities', 'target_wt_lbs', 'machining_required', 'customer_code', 'industry'],
        PARTS.map((p) => [p.part_num, p.description, p.alloy, p.process, p.pattern_num, p.cavities, p.target_wt_lbs, p.machining_required, p.customer_code, p.industry]));

    // ---- reconciliation bridges -----------------------------------------
    await record('xref.part_pattern', 'xref.part_pattern',
        ['part_num', 'pattern_code', 'mapped_by', 'mapped_at'],
        PARTS.filter((p) => p.thrive_pattern !== null).map((p) => [
            p.part_num, p.thrive_pattern, 'tooling_engineering', dateOnly(addDays(DATASET_START, rng.int(0, 120))),
        ]));

    await record('xref.wc_tag', 'xref.wc_tag',
        ['wc_code', 'tag_prefix', 'signal_role'],
        WC_TAG_MAP.map((m) => [m.wc_code, m.tag_prefix, m.signal_role]));

    // ---- jobs, operations, labor, scrap ---------------------------------
    interface JobRow {
        job_num: string; part: PartDef; qty_ordered: number; qty_completed: number;
        req_due_date: Date; created_at: Date; closed: boolean;
        startedAt: Date; endedAt: Date; furnaceId: string; opsRemaining: number;
        gasporQty: number;
    }

    const jobs: JobRow[] = [];
    const jobHeadRows: unknown[][] = [];
    const jobOperRows: unknown[][] = [];
    const laborRows: unknown[][] = [];
    const scrapRows: unknown[][] = [];

    // Parts weighted so the signal-carrying families have enough job history to
    // establish a trend rather than a couple of noisy points.
    const partWeights = PARTS.map((p) => {
        if (p.part_num === '4471-BRKT') return [p, 12] as const;
        if (p.part_num === '4482-BRKT') return [p, 8] as const;
        if (p.part_num === '3320-HSG' || p.part_num === '3321-HSG') return [p, 6] as const;
        if (p.thrive_pattern === null) return [p, 2] as const;
        return [p, 4] as const;
    });

    let jobSeq = 100000;

    // The flagship question ("scrap is up on the bracket — is the customer's
    // expedite at risk?") needs a job that is simultaneously mid-routing,
    // carrying porosity scrap, and due soon. At ~11% part share and ~2.3 jobs a
    // day, only a job released in the last two or three days is still mid-
    // routing, so leaving that to chance means the demo silently breaks on some
    // seeds. These are released deliberately — as is every other signal in this
    // dataset — with a large quantity so the later operations are still running
    // when the dataset's clock stops.
    const bracketPart = PARTS.find((p) => p.part_num === '4471-BRKT')!;
    // Several release days rather than a couple: whether any individual job ends
    // up mid-routing when the dataset's clock stops depends on how its operation
    // durations fall, so a few candidates keeps the flagship reliable.
    const FLAGSHIP_DAYS = new Set([
        TOTAL_DAYS - 2, TOTAL_DAYS - 3, TOTAL_DAYS - 5, TOTAL_DAYS - 7, TOTAL_DAYS - 9,
    ]);

    for (let day = 0; day < TOTAL_DAYS; day++) {
        const date = addDays(DATASET_START, day);
        if (isWeekend(date)) continue;

        const plantFlagship = FLAGSHIP_DAYS.has(day);
        const jobsToday = rng.weighted([[1, 2], [2, 5], [3, 4], [4, 2], [0, 1]])
                        + (plantFlagship ? 1 : 0);

        for (let n = 0; n < jobsToday; n++) {
            const isFlagship = plantFlagship && n === 0;
            const part = isFlagship ? bracketPart : rng.weighted(partWeights);
            const jobNum = `J-${jobSeq++}`;
            const qty = isFlagship
                ? 350                                   // long ops -> work remains
                : rng.weighted([[40, 3], [80, 4], [120, 3], [200, 2], [350, 1]]);
            const createdAt = new Date(date.getTime() + rng.int(6, 10) * 3_600_000);
            // Tight lead times on the planted jobs. Signal 4 is only real if the
            // machining cell's lost capacity actually makes something late —
            // with comfortable due dates every job clears despite the breakdown,
            // and the "what is at risk" question returns nothing.
            const leadDays = isFlagship ? rng.int(5, 10) : rng.int(12, 38);
            const dueDate = addDays(date, leadDays);
            const closed = day < TOTAL_DAYS - OPEN_JOB_WINDOW;

            // Furnace assignment is decided ONCE per job and drives both the
            // Epicor melt work center and the Thrive heat record. They describe
            // the same physical furnace, so MELT-F3 <-> FURN-3 <-> the
            // Melt/Furnace3/* tag tree all line up. Getting this wrong makes
            // Thrive and Ignition appear to contradict each other on the same
            // job, which would discredit the corroboration the demo rests on.
            const furnaceId = part.alloy === 'A356' ? 'FURN-3' : 'FURN-1';
            const meltWc = furnaceId === 'FURN-3' ? 'MELT-F3' : 'MELT-F1';

            // Routing: melt -> form -> clean -> [heat treat] -> [machine]
            const formWc = part.process === 'SAND'
                ? rng.pick(['MOLD-L1', 'MOLD-L2'])
                : rng.pick(['PM-PRESS1', 'PM-PRESS2']);
            const cleanWc = rng.pick(['CLEAN-1', 'CLEAN-2']);

            const routing: { seq: number; wc: string }[] = [
                { seq: 10, wc: meltWc },
                { seq: 20, wc: formWc },
                { seq: 30, wc: cleanWc },
            ];
            if (part.alloy.includes('T6')) routing.push({ seq: 40, wc: 'HT-1' });
            if (part.machining_required) {
                // Draw unconditionally, then override. Making an rng call
                // conditional would consume a different number of draws on
                // flagship days and desynchronise the whole downstream stream —
                // still deterministic, but it silently reshuffles every later
                // job and can break the planted signals.
                const machCell = rng.pick(['MACH-CELL1', 'MACH-CELL2']);
                // Planted jobs route through the cell that breaks down, so
                // signals 1 and 4 land on the same work. That is deliberate and
                // realistic: an expedite in trouble is usually in trouble for
                // more than one reason at once.
                routing.push({ seq: 50, wc: isFlagship ? 'MACH-CELL1' : machCell });
            }

            const molds = Math.ceil(qty / part.cavities);
            let jobScrapTotal = 0;
            let lastRunQtyCompleted = 0;   // header qty must agree with the detail
            let opsRemaining = 0;
            let gasporQty = 0;
            let workEnd = new Date(createdAt.getTime() + rng.int(12, 72) * 3_600_000);
            // The first operation that actually ran. Pours are placed inside
            // [firstOpStart, workEnd] so they always fall within xref.job_window,
            // which is derived from labor records — otherwise a pour can land
            // before the job's first clock-in and the heat never resolves.
            let firstOpStart: Date | null = null;

            for (const op of routing) {
                const estSetup = Number(rng.range(0.5, 2.5).toFixed(2));
                const perPieceHrs =
                    op.seq === 10 ? 0.004 :
                    op.seq === 20 ? 0.030 :
                    op.seq === 30 ? 0.055 :
                    op.seq === 40 ? 0.010 : 0.075;
                const estProd = Number(Math.max(0.5, molds * perPieceHrs * part.cavities).toFixed(2));

                // --- efficiency, carrying signals 2 and 3 -------------------
                let efficiency = rng.normal(1.02, 0.10);

                // Signal 3: the standard on the CLEAN operation for the pump
                // housing family is simply wrong — set years ago, never revised.
                // Consistent ~25% overrun across every job and every operator,
                // which is what distinguishes a bad standard from a bad crew.
                if (op.seq === 30 && (part.part_num === '3320-HSG' || part.part_num === '3321-HSG')) {
                    efficiency *= 1.25;
                }

                const shift = rng.weighted([[1, 5], [2, 4], [3, 1]]);

                // Signal 2: second shift on mold line 2 degrades after the
                // new-hire cohort starts, then partially recovers as they learn.
                const newHireContext = op.wc === 'MOLD-L2' && shift === 2 && day >= NEW_HIRE_START;
                if (newHireContext) {
                    const weeksIn = (day - NEW_HIRE_START) / 7;
                    const penalty = 0.22 * Math.exp(-weeksIn / 26);   // decays as they learn
                    efficiency *= 1 + penalty;
                }

                const actSetup = Number(Math.max(0.1, estSetup * rng.normal(1.05, 0.18)).toFixed(2));
                const actProd = Number(Math.max(0.1, estProd * efficiency).toFixed(2));

                // --- scrap --------------------------------------------------
                // Baseline process scrap. Forming and cleaning carry most of it.
                const baseRate =
                    op.seq === 20 ? rng.range(0.010, 0.040) :
                    op.seq === 30 ? rng.range(0.004, 0.018) :
                    op.seq === 50 ? rng.range(0.002, 0.012) : rng.range(0, 0.004);

                // Signal 1: under-degassed metal ADDS gas-porosity scrap on top
                // of the baseline rather than relabeling part of it. Additive is
                // both the physically correct story — the hydrogen is already in
                // the metal, so those castings are lost on top of whatever the
                // process was losing anyway — and the reason the weekly trend
                // climbs steadily instead of sloshing around as a share of a
                // small random pool.
                const porosityRate = op.seq === 20
                    ? 0.075 * degasDeficit(furnaceId, day) * porositySusceptibility(part)
                    : 0;

                const baseScrap = Math.round(qty * baseRate);
                const porosityScrap = Math.round(qty * porosityRate);
                const opScrap = baseScrap + porosityScrap;

                const opStart = new Date(workEnd.getTime() + rng.int(2, 30) * 3_600_000);
                const opEnd = new Date(opStart.getTime() + (actSetup + actProd) * 3_600_000);

                // Has the floor actually reached this operation yet? A released
                // Epicor job carries every operation with its estimate from the
                // start; actuals fill in as work happens. So an operation still
                // ahead of the job is recorded with estimates and ZERO actuals —
                // which is exactly what makes remaining-hours, and therefore the
                // at-risk calculation, computable.
                const hasRun = opEnd <= DATASET_TODAY;
                if (hasRun) workEnd = opEnd;

                jobOperRows.push(
                    hasRun
                        ? [jobNum, op.seq, op.wc, estSetup, estProd, actSetup, actProd,
                           Math.max(0, qty - opScrap), opScrap]
                        : [jobNum, op.seq, op.wc, estSetup, estProd, 0, 0, 0, 0],
                );

                if (!hasRun) { opsRemaining++; continue; }   // not yet on the floor
                jobScrapTotal += opScrap;
                lastRunQtyCompleted = Math.max(0, qty - opScrap);
                if (firstOpStart === null) firstOpStart = opStart;

                // --- labor detail ------------------------------------------
                const crewSize = op.seq === 30 ? rng.int(1, 3) : rng.int(1, 2);
                const pool = newHireContext && rng.chance(0.7) ? NEW_HIRE_EMPLOYEES : VETERAN_EMPLOYEES;
                const crew = rng.shuffle([...pool]).slice(0, crewSize);
                const hoursEach = (actSetup + actProd) / crewSize;

                for (const employee of crew) {
                    const clockIn = new Date(opStart.getTime() + rng.int(0, 90) * 60_000);
                    const clockOut = new Date(clockIn.getTime() + hoursEach * 3_600_000);
                    laborRows.push([
                        employee, jobNum, op.seq, ts(clockIn), ts(clockOut),
                        Number(hoursEach.toFixed(2)),
                        rng.chance(0.12) ? 'S' : 'P',
                        shift,
                    ]);
                }

                // --- scrap detail, attributed to a plausible reason ---------
                // Baseline scrap, split across one to three entries. A low rate
                // of gas porosity is always present; every foundry has some.
                if (baseScrap > 0) {
                    let remaining = baseScrap;
                    const entries = rng.int(1, 3);
                    for (let e = 0; e < entries && remaining > 0; e++) {
                        const isLast = e === entries - 1;
                        const chunk = isLast ? remaining : Math.max(1, Math.round(remaining * rng.range(0.3, 0.7)));
                        remaining -= chunk;

                        const reason =
                            op.seq === 50 ? 'MACH'
                            : rng.chance(0.10) ? 'GASPOR'
                            : rng.weighted([
                                ['SHRINK', 3], ['COLDSHUT', 3], ['MISRUN', 2],
                                ['INCL', 2], ['CORE', 2], ['HOTTEAR', 1],
                                ['SANDINC', 2], ['DIMEN', 2],
                            ]);

                        scrapRows.push([
                            jobNum, op.seq, chunk, reason,
                            ts(new Date(opEnd.getTime() - rng.int(0, 4) * 3_600_000)),
                        ]);
                    }
                }

                // Porosity scrap from the degas shortfall, logged on its own.
                // Gas porosity is a melt-side defect that surfaces at the
                // forming operation — Epicor records where it was FOUND, and
                // only Thrive and Ignition know where it was CAUSED.
                if (porosityScrap > 0) {
                    gasporQty += porosityScrap;
                    scrapRows.push([
                        jobNum, op.seq, porosityScrap, 'GASPOR',
                        ts(new Date(opEnd.getTime() - rng.int(0, 4) * 3_600_000)),
                    ]);
                }
            }

            // A closed job shipped what survived every operation. An open job
            // has completed only as far as its last finished operation.
            const qtyCompleted = closed
                ? Math.max(0, qty - jobScrapTotal)
                : lastRunQtyCompleted;

            jobs.push({
                job_num: jobNum, part, qty_ordered: qty, qty_completed: qtyCompleted,
                req_due_date: dueDate, created_at: createdAt, closed,
                startedAt: firstOpStart ?? workEnd, endedAt: workEnd,
                furnaceId, opsRemaining, gasporQty,
            });
            jobHeadRows.push([
                jobNum, part.part_num, qty, qtyCompleted, dateOnly(dueDate),
                true, closed, true, ts(createdAt),
            ]);
        }
    }

    await record('epicor.job_head', 'epicor.job_head',
        ['job_num', 'part_num', 'qty_ordered', 'qty_completed', 'req_due_date', 'job_released', 'job_closed', 'job_engineered', 'created_at'],
        jobHeadRows);
    await record('epicor.job_oper', 'epicor.job_oper',
        ['job_num', 'oper_seq', 'wc_code', 'est_setup_hrs', 'est_prod_hrs', 'act_setup_hrs', 'act_prod_hrs', 'qty_completed', 'scrap_qty'],
        jobOperRows);
    await record('epicor.labor_dtl', 'epicor.labor_dtl',
        ['employee_num', 'job_num', 'oper_seq', 'clock_in', 'clock_out', 'labor_hrs', 'labor_type', 'shift'],
        laborRows);
    await record('epicor.scrap_dtl', 'epicor.scrap_dtl',
        ['job_num', 'oper_seq', 'scrap_qty', 'reason_code', 'logged_at'],
        scrapRows);

    // ---- Thrive: heats, pours, inspection --------------------------------
    // Heats are created per (day, furnace, alloy) and shared across the jobs
    // pouring that combination, which is how a melt deck actually works — and is
    // why a job cannot be joined to a heat without both the pattern bridge and a
    // time window.
    //
    // Alloy is part of the key, not decoration: you do not pour 319 and 535 out
    // of the same heat. An earlier version picked alloy_spec at random, which
    // produced A356 brackets resolving to heats labelled 535.0 — incoherent to
    // anyone who reads a melt log, and caught immediately the first time the
    // copilot was asked about a real job.
    const heatRows: unknown[][] = [];
    const pourRows: unknown[][] = [];
    const inspectRows: unknown[][] = [];
    const heatRegistry = new Map<string, string>();
    let heatSeq = 1;

    /** Epicor alloy designation -> the spec string Thrive records on a heat. */
    const THRIVE_ALLOY_SPEC: Record<string, string> = {
        'A356': 'A356.2',
        '356-T6': 'A356.2-T6',
        '319': '319.1',
        '535': '535.0',
    };

    const heatNumFor = (date: Date, furnaceId: string, alloySpec: string): string => {
        const key = `${dateOnly(date)}|${furnaceId}|${alloySpec}`;
        const existing = heatRegistry.get(key);
        if (existing) return existing;

        const day = dayOf(date);
        const heatNum = `H26-${String(heatSeq++).padStart(4, '0')}`;
        heatRegistry.set(key, heatNum);

        const degas = degasMinutesFor(furnaceId, day);
        const charged = rng.range(1800, 2600);

        // Signal 5: returns creep up across the dataset — remelt ratio drifting,
        // which is what makes cost-per-good-casting move independently of scrap.
        const returnsRatio = 0.09 + 0.05 * (day / TOTAL_DAYS) + rng.range(-0.015, 0.015);
        const returns = charged * Math.max(0.04, returnsRatio);

        // Reduced-pressure test density falls as degas time falls: less
        // degassing leaves more dissolved hydrogen. This is the physical link
        // that makes signal 1 defensible rather than a coincidence.
        const density = 2.62 - Math.max(0, (12 - degas)) * 0.018 + rng.range(-0.012, 0.012);

        heatRows.push([
            heatNum,
            alloySpec,
            furnaceId,
            ts(new Date(date.getTime() + rng.int(5, 20) * 3_600_000)),
            Number(charged.toFixed(2)),
            Number((charged - returns).toFixed(2)),
            Number(returns.toFixed(2)),
            Number(degas.toFixed(2)),
            // Reduced-pressure test is run most heats but not all — it is a
            // per-shift sample, not a per-heat gate. Coverage is high enough
            // that any given job resolves to at least one tested heat.
            rng.chance(0.88) ? Number(density.toFixed(3)) : null,
        ]);
        return heatNum;
    };

    for (const job of jobs) {
        if (!job.part.thrive_pattern) continue;   // unmapped parts pour nothing we can trace

        // Same furnace the Epicor melt operation ran on — decided once, on the
        // job, so the two systems never contradict each other.
        const furnace = job.furnaceId;
        const pours = rng.int(1, 4);
        for (let p = 0; p < pours; p++) {
            // Place the pour at a millisecond offset inside the job's active
            // window rather than on a rounded day boundary — a day-granular
            // pour can land outside xref.job_window and silently fail to
            // resolve, which is what made the flagship job show no heats.
            const windowMs = Math.max(
                3_600_000, job.endedAt.getTime() - job.startedAt.getTime(),
            );
            const pouredAt = new Date(job.startedAt.getTime() + rng.range(0, windowMs));
            if (pouredAt > DATASET_TODAY) continue;

            const heatNum = heatNumFor(pouredAt, furnace, THRIVE_ALLOY_SPEC[job.part.alloy] ?? 'A356.2');
            pourRows.push([
                heatNum, job.part.thrive_pattern,
                Math.ceil(job.qty_ordered / job.part.cavities / pours), ts(pouredAt),
            ]);

            if (rng.chance(0.35)) {
                const sample = rng.int(5, 20);
                const fail = rng.chance(0.25) ? rng.int(1, Math.max(1, Math.floor(sample * 0.3))) : 0;
                inspectRows.push([
                    job.part.thrive_pattern, heatNum, sample, sample - fail, fail,
                    fail > 0
                        ? EPICOR_TO_THRIVE_DEFECT[rng.pick(['GASPOR', 'SHRINK', 'COLDSHUT', 'INCL', 'DIMEN'])]
                        : null,
                    ts(new Date(pouredAt.getTime() + rng.int(4, 48) * 3_600_000)),
                ]);
            }
        }
    }

    // A development pattern the melt deck ran that the ERP never knew about.
    for (let i = 0; i < 6; i++) {
        const date = addDays(DATASET_START, rng.int(30, TOTAL_DAYS - 10));
        const devFurnace = rng.pick(['FURN-1', 'FURN-3']);
        const heatNum = heatNumFor(date, devFurnace,
            devFurnace === 'FURN-3' ? 'A356.2' : rng.pick(['319.1', '535.0']));
        pourRows.push([heatNum, ORPHAN_THRIVE_PATTERN, rng.int(4, 20),
            ts(new Date(date.getTime() + rng.int(6, 20) * 3_600_000))]);
    }

    await record('thrive.heat', 'thrive.heat',
        ['heat_num', 'alloy_spec', 'furnace_id', 'poured_at', 'lbs_charged', 'lbs_poured', 'lbs_returns', 'degas_minutes', 'rpt_density'],
        heatRows);
    await record('thrive.pour_record', 'thrive.pour_record',
        ['heat_num', 'pattern_code', 'molds_poured', 'poured_at'], pourRows);
    await record('thrive.inspect_result', 'thrive.inspect_result',
        ['pattern_code', 'heat_num', 'sample_qty', 'pass_qty', 'fail_qty', 'defect_code', 'inspected_at'],
        inspectRows);

    // ---- Ignition: historian tags and downtime ---------------------------
    const tagRows: unknown[][] = [];
    for (let day = 0; day < TOTAL_DAYS; day++) {
        const date = addDays(DATASET_START, day);
        for (let hour = 0; hour < 24; hour += 2) {
            const sampleTs = new Date(date.getTime() + hour * 3_600_000);
            if (sampleTs > DATASET_TODAY) break;

            for (const tag of IGNITION_TAGS) {
                let value: number;
                if (tag.role === 'DEGAS') {
                    // The historian's own view of the same drift Thrive records
                    // per heat. Corroboration across two systems is what makes
                    // the finding credible rather than a single-source artifact.
                    value = degasMinutesFor('FURN-3', day);
                } else if (tag.role === 'STATE' && day >= DOWNTIME_CLUSTER) {
                    // Spindle load collapses during the machining stoppages.
                    value = rng.chance(0.3) ? rng.range(0, 8) : rng.normal(tag.baseline, tag.noise);
                } else if (isWeekend(date) && tag.role === 'COUNT') {
                    value = 0;
                } else {
                    value = rng.normal(tag.baseline, tag.noise);
                }
                tagRows.push([tag.tag_path, ts(sampleTs), Number(value.toFixed(3)), 192]);
            }
        }
    }
    await record('ignition.tag_history', 'ignition.tag_history',
        ['tag_path', 'ts', 'value_float', 'quality'], tagRows);

    const downtimeRows: unknown[][] = [];
    const ROUTINE_REASONS = [
        'die change', 'Die Change', 'preventive maint', 'PM - scheduled',
        'sand system jam', 'operator break - relief late', 'tooling swap',
    ];
    // Routine, spread across the dataset.
    for (let day = 0; day < TOTAL_DAYS; day++) {
        if (rng.chance(0.35)) {
            const date = addDays(DATASET_START, day);
            const tag = rng.pick(IGNITION_TAGS.filter((t) => t.role !== 'PRESSURE'));
            const start = new Date(date.getTime() + rng.int(6, 20) * 3_600_000);
            downtimeRows.push([
                tag.tag_path, ts(start),
                ts(new Date(start.getTime() + rng.range(0.4, 3.5) * 3_600_000)),
                rng.pick(ROUTINE_REASONS),
            ]);
        }
    }
    // Signal 4: an unplanned breakdown cluster on machining cell 1 in the final
    // three weeks. Free-text reasons, typed inconsistently, as they really are.
    const BREAKDOWN_REASONS = [
        'spindle fault', 'SPINDLE FAULT - waiting on parts', 'spindle alarm again',
        'coolant pump failure', 'unplanned - spindle', 'down, maint called',
    ];
    for (let day = DOWNTIME_CLUSTER; day < TOTAL_DAYS; day++) {
        const date = addDays(DATASET_START, day);
        if (isWeekend(date) || !rng.chance(0.8)) continue;
        const start = new Date(date.getTime() + rng.int(5, 21) * 3_600_000);
        downtimeRows.push([
            'Machining/Cell1/SpindleLoadPct', ts(start),
            ts(new Date(start.getTime() + rng.range(3.0, 10.0) * 3_600_000)),
            rng.pick(BREAKDOWN_REASONS),
        ]);
    }
    await record('ignition.downtime_event', 'ignition.downtime_event',
        ['tag_path', 'started_at', 'ended_at', 'reason_text'], downtimeRows);

    // ---- monday.com: customer commitments --------------------------------
    // The Job # column is free text. Four formats plus blanks and a stale
    // placeholder, which is what xref.normalize_job_ref() has to survive.
    const boardRows: unknown[][] = [];
    const columnRows: unknown[][] = [];
    let itemId = 7_700_000_000;

    const recentJobs = jobs.filter((j) => dayOf(j.created_at) > TOTAL_DAYS - 120);

    // The expedite has to land on a job that carries the whole story at once:
    //   - poured during the degas decay, and actually accrued porosity scrap,
    //     so Epicor/Thrive/Ignition all have something to say about it;
    //   - already past melt and molding, so those heats exist and resolve;
    //   - still has operations ahead of it, so "is it at risk?" is a real
    //     question rather than trivially "no".
    // Dropping any one of these conditions produces a job that looks fine from
    // one system and empty from another, and the flagship demo falls flat.
    const bracketCandidates = jobs
        .filter((j) => j.part.part_num === '4471-BRKT'
                    && !j.closed
                    && dayOf(j.created_at) >= DEGAS_DECAY_START
                    && j.gasporQty > 0)
        .sort((a, b) => a.req_due_date.getTime() - b.req_due_date.getTime());

    // Ideal: still mid-routing AND already producing. Fall back to any bracket
    // job carrying porosity scrap rather than failing the whole seed — the
    // four-source story still holds, it is only the "work remaining" leg that
    // weakens.
    const ideal = bracketCandidates.filter((j) => j.opsRemaining > 0 && j.qty_completed > 0);
    const expediteTargets = ideal.length > 0 ? ideal : bracketCandidates;

    if (expediteTargets.length === 0) {
        throw new Error(
            'No open 4471-BRKT job carrying porosity scrap is available to attach the ' +
            'flagship expedite to. The four-source demo question depends on one existing — ' +
            'check FLAGSHIP_DAYS, OPEN_JOB_WINDOW, and the part weighting.',
        );
    }
    if (ideal.length === 0) {
        console.log('  ! flagship expedite fell back to a job with no operations remaining');
    }

    const formatJobRef = (jobNum: string): string => {
        const digits = jobNum.replace('J-', '');
        return rng.weighted([
            [jobNum, 40],
            [`J${digits}`, 20],
            [digits, 20],
            [`Job ${digits}`, 12],
            ['', 4],
            ['TBD', 4],
        ]);
    };

    const pushItem = (
        board: string, name: string, status: string, customer: string,
        promised: Date | null, created: Date, jobRef: string, notes: string,
    ) => {
        const id = itemId++;
        boardRows.push([id, board, name, status, customer,
            promised ? dateOnly(promised) : null, ts(created)]);
        columnRows.push([id, 'Job #', jobRef]);
        columnRows.push([id, 'Notes', notes]);
        columnRows.push([id, 'Priority', rng.pick(['Low', 'Medium', 'High', 'Critical'])]);
        columnRows.push([id, 'Owner', rng.pick(['R. Kessler', 'M. Alvarez', 'T. Boyd', 'S. Nguyen'])]);
        return id;
    };

    // The expedite tied to the gas-porosity jobs — the fourth leg of signal 1.
    for (const job of expediteTargets.slice(0, 3)) {
        pushItem(
            'Customer Expedites',
            `EXPEDITE - ${job.part.description} (${job.part.part_num})`,
            'Stuck',
            'Deere & Co',
            addDays(job.req_due_date, -4),
            addDays(job.created_at, 3),
            formatJobRef(job.job_num),
            'Customer pulled in need-by date. Line down risk at their plant. Quality holds on recent lots — see inspection.',
        );
    }

    for (const job of rng.shuffle(recentJobs).slice(0, 150)) {
        const board = rng.weighted([
            ['Customer Expedites', 3], ['Quality Holds', 3], ['New Part Launches', 2],
        ]);
        const status = rng.weighted([
            ['Working on it', 4], ['Done', 4], ['Stuck', 2], ['Waiting for customer', 1],
        ]);
        pushItem(
            board,
            `${board === 'Quality Holds' ? 'HOLD' : board === 'New Part Launches' ? 'PPAP' : 'Expedite'} - ${job.part.part_num}`,
            status,
            // The customer who actually buys this part, not a random one.
            CUSTOMER_DISPLAY[job.part.customer_code] ?? job.part.customer_code,
            rng.chance(0.8) ? addDays(job.req_due_date, rng.int(-6, 6)) : null,
            addDays(job.created_at, rng.int(0, 6)),
            formatJobRef(job.job_num),
            rng.pick([
                'Customer called for status.', 'Awaiting first article approval.',
                'Hold pending dimensional review.', 'Pulled in two weeks.',
                'Short ship acceptable per buyer.', 'Escalated by account manager.',
            ]),
        );
    }

    // Items whose Job # points at a job that does not exist in Epicor — a
    // deleted job, or a typo nobody caught.
    for (let i = 0; i < 4; i++) {
        pushItem('Quality Holds', 'HOLD - unlinked', 'Stuck',
            rng.pick(MONDAY_CUSTOMERS), null,
            addDays(DATASET_TODAY, -rng.int(5, 60)),
            `J-9${String(rng.int(10000, 99999)).slice(0, 5)}`,
            'Job number does not match anything in Epicor. Needs research.');
    }

    await record('monday.board_item', 'monday.board_item',
        ['item_id', 'board_name', 'item_name', 'status', 'customer', 'promised_date', 'created_at'],
        boardRows);
    await record('monday.column_value', 'monday.column_value',
        ['item_id', 'column_title', 'text_value'], columnRows);

    // ---- summary ---------------------------------------------------------
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`\n  ${'TOTAL'.padEnd(28)} ${String(total).padStart(7)} rows`);
    console.log(`\ndataset window: ${dateOnly(DATASET_START)} .. ${dateOnly(DATASET_TODAY)} (${TOTAL_DAYS} days)`);
    console.log(`seed: ${SEED}\n`);

    await client.end();
}

main().catch((err) => {
    console.error('\nseed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
