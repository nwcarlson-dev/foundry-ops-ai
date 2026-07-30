/**
 * Verifies the seeded database: that the five planted signals are actually
 * present and detectable, and that the reconciliation layer behaves as designed.
 *
 * This exists because the failure mode that would actually hurt is a copilot
 * confidently reporting a number that is wrong. If a signal silently stops
 * generating, every downstream surface lies. Run after every seed.
 *
 *   npm run verify
 *
 * Exits non-zero if any check fails.
 */
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { Client } from '@neondatabase/serverless';

import { connect } from './lib/db';

const root = process.cwd();
loadEnv({ path: join(root, '.env.local'), quiet: true });
loadEnv({ path: join(root, '.env'), quiet: true });

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail: string) {
    if (ok) {
        passed++;
        console.log(`  PASS  ${label}`);
        if (detail) console.log(`        ${detail}`);
    } else {
        failed++;
        console.log(`  FAIL  ${label}`);
        console.log(`        ${detail}`);
    }
}

function section(title: string) {
    console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

const num = (v: unknown) => (v === null || v === undefined ? NaN : Number(v));

async function main() {
    const client: Client = await connect();

    // ------------------------------------------------------------------
    section('Row counts');
    const tables = [
        'epicor.part', 'epicor.work_center', 'epicor.job_head', 'epicor.job_oper',
        'epicor.labor_dtl', 'epicor.scrap_dtl', 'thrive.heat', 'thrive.pour_record',
        'thrive.inspect_result', 'ignition.tag_history', 'ignition.downtime_event',
        'monday.board_item', 'monday.column_value', 'xref.part_pattern', 'xref.wc_tag',
    ];
    for (const t of tables) {
        const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
        const n = rows[0].n as number;
        check(`${t} is populated`, n > 0, `${n} rows`);
    }

    // ------------------------------------------------------------------
    section('Signal 1 — gas porosity on 4471-BRKT (Epicor + Thrive + Ignition + monday)');

    // (a) Epicor: GASPOR share of scrap rises in the final 8 weeks.
    const gaspor = await client.query(`
        WITH windowed AS (
            SELECT
                CASE WHEN sd.logged_at >= (SELECT MAX(logged_at) FROM epicor.scrap_dtl) - INTERVAL '56 days'
                     THEN 'recent' ELSE 'baseline' END AS period,
                sd.reason_code,
                sd.scrap_qty
            FROM epicor.scrap_dtl sd
            JOIN epicor.job_head jh ON jh.job_num = sd.job_num
            WHERE jh.part_num IN ('4471-BRKT', '4482-BRKT')
        )
        SELECT period,
               SUM(scrap_qty) FILTER (WHERE reason_code = 'GASPOR')::float
                   / NULLIF(SUM(scrap_qty), 0) AS gaspor_share
        FROM windowed GROUP BY period
    `);
    const shares = Object.fromEntries(
        gaspor.rows.map((r: Record<string, unknown>) => [r.period, num(r.gaspor_share)]),
    );
    check(
        'Epicor: GASPOR share of scrap climbs on the bracket family',
        shares.recent > shares.baseline * 1.8,
        `baseline ${(shares.baseline * 100).toFixed(1)}% -> recent ${(shares.recent * 100).toFixed(1)}%`,
    );

    // (b) Thrive: degas minutes on FURN-3 fall over the same window.
    const degas = await client.query(`
        SELECT
            AVG(degas_minutes) FILTER (
                WHERE poured_at < (SELECT MAX(poured_at) FROM thrive.heat) - INTERVAL '56 days'
            ) AS baseline,
            AVG(degas_minutes) FILTER (
                WHERE poured_at >= (SELECT MAX(poured_at) FROM thrive.heat) - INTERVAL '14 days'
            ) AS recent
        FROM thrive.heat WHERE furnace_id = 'FURN-3'
    `);
    const dBase = num(degas.rows[0].baseline);
    const dRecent = num(degas.rows[0].recent);
    check(
        'Thrive: FURN-3 degas minutes decay',
        dRecent < dBase * 0.75,
        `baseline ${dBase.toFixed(1)} min -> last 2 weeks ${dRecent.toFixed(1)} min`,
    );

    // (c) Ignition: the historian corroborates independently.
    const degasTag = await client.query(`
        SELECT
            AVG(value_float) FILTER (
                WHERE ts < (SELECT MAX(ts) FROM ignition.tag_history) - INTERVAL '56 days'
            ) AS baseline,
            AVG(value_float) FILTER (
                WHERE ts >= (SELECT MAX(ts) FROM ignition.tag_history) - INTERVAL '14 days'
            ) AS recent
        FROM ignition.tag_history WHERE tag_path = 'Melt/Furnace3/DegasMinutes'
    `);
    const tBase = num(degasTag.rows[0].baseline);
    const tRecent = num(degasTag.rows[0].recent);
    check(
        'Ignition: degas tag independently shows the same decay',
        tRecent < tBase * 0.75,
        `baseline ${tBase.toFixed(1)} -> last 2 weeks ${tRecent.toFixed(1)}`,
    );

    // (d) Thrive: RPT density falls with degas time — the physical mechanism.
    const rpt = await client.query(`
        SELECT corr(degas_minutes, rpt_density) AS r
        FROM thrive.heat WHERE furnace_id = 'FURN-3' AND rpt_density IS NOT NULL
    `);
    const r = num(rpt.rows[0].r);
    check(
        'Thrive: RPT density correlates with degas time (the mechanism)',
        r > 0.4,
        `Pearson r = ${r.toFixed(3)} (positive: less degassing -> lower density -> more gas)`,
    );

    // (e) monday: a customer expedite resolves onto an affected job.
    const expedite = await client.query(`
        SELECT COUNT(*)::int AS n
        FROM xref.job_monday_item jmi
        JOIN epicor.job_head jh ON jh.job_num = jmi.resolved_job_num
        WHERE jh.part_num = '4471-BRKT' AND jmi.status = 'Stuck'
    `);
    check(
        'monday: a stuck expedite reconciles onto an affected job',
        (expedite.rows[0].n as number) > 0,
        `${expedite.rows[0].n} expedite item(s) linked through xref.normalize_job_ref()`,
    );

    // ------------------------------------------------------------------
    section('Signal 2 — second-shift efficiency on MOLD-L2 after the new-hire cohort');
    const shiftEff = await client.query(`
        WITH op AS (
            SELECT jo.job_num, jo.oper_seq, jo.est_prod_hrs, jo.act_prod_hrs,
                   MIN(ld.shift) AS shift, MIN(ld.clock_in) AS started
            FROM epicor.job_oper jo
            JOIN epicor.labor_dtl ld
                   ON ld.job_num = jo.job_num AND ld.oper_seq = jo.oper_seq
            WHERE jo.wc_code = 'MOLD-L2' AND jo.est_prod_hrs > 0
            GROUP BY jo.job_num, jo.oper_seq, jo.est_prod_hrs, jo.act_prod_hrs
        )
        SELECT shift,
               AVG(act_prod_hrs / est_prod_hrs) FILTER (
                   WHERE started < (SELECT MIN(started) FROM op) + INTERVAL '380 days') AS before_cohort,
               AVG(act_prod_hrs / est_prod_hrs) FILTER (
                   WHERE started >= (SELECT MIN(started) FROM op) + INTERVAL '380 days') AS after_cohort
        FROM op WHERE shift IN (1, 2) GROUP BY shift ORDER BY shift
    `);
    const byShift = Object.fromEntries(
        shiftEff.rows.map((r: Record<string, unknown>) => [
            String(r.shift), { before: num(r.before_cohort), after: num(r.after_cohort) },
        ]),
    );
    const s2Delta = byShift['2'].after - byShift['2'].before;
    const s1Delta = byShift['1'].after - byShift['1'].before;
    check(
        'Second shift degrades relative to first after the cohort start',
        s2Delta > s1Delta + 0.05,
        `shift 2: ${byShift['2'].before.toFixed(3)} -> ${byShift['2'].after.toFixed(3)} ` +
        `(delta ${s2Delta >= 0 ? '+' : ''}${s2Delta.toFixed(3)}) vs ` +
        `shift 1 delta ${s1Delta >= 0 ? '+' : ''}${s1Delta.toFixed(3)}`,
    );

    const newHires = await client.query(`
        SELECT COUNT(DISTINCT employee_num)::int AS n
        FROM epicor.labor_dtl WHERE employee_num LIKE 'E-2%'
    `);
    check(
        'New-hire employee numbers appear in labor detail',
        (newHires.rows[0].n as number) > 0,
        `${newHires.rows[0].n} operators with E-2xxx numbers`,
    );

    // ------------------------------------------------------------------
    section('Signal 3 — wrong standard on the pump-housing CLEAN operation');
    const standard = await client.query(`
        SELECT
            AVG(act_prod_hrs / est_prod_hrs) FILTER (
                WHERE jh.part_num IN ('3320-HSG', '3321-HSG')) AS housing,
            AVG(act_prod_hrs / est_prod_hrs) FILTER (
                WHERE jh.part_num NOT IN ('3320-HSG', '3321-HSG')) AS everything_else
        FROM epicor.job_oper jo
        JOIN epicor.job_head jh ON jh.job_num = jo.job_num
        WHERE jo.oper_seq = 30 AND jo.est_prod_hrs > 0
    `);
    const housing = num(standard.rows[0].housing);
    const other = num(standard.rows[0].everything_else);
    check(
        'Pump housings run consistently over standard on the CLEAN op',
        housing > other * 1.15,
        `housing family ${housing.toFixed(3)}x standard vs ${other.toFixed(3)}x for everything else`,
    );

    // A bad standard shows up across all operators, not a few — that is what
    // separates it from an operator-performance problem.
    const spread = await client.query(`
        SELECT COUNT(DISTINCT ld.employee_num)::int AS operators
        FROM epicor.job_oper jo
        JOIN epicor.job_head jh ON jh.job_num = jo.job_num
        JOIN epicor.labor_dtl ld ON ld.job_num = jo.job_num AND ld.oper_seq = jo.oper_seq
        WHERE jo.oper_seq = 30 AND jh.part_num IN ('3320-HSG', '3321-HSG')
          AND jo.act_prod_hrs > jo.est_prod_hrs * 1.15
    `);
    check(
        'The overrun spans many operators (a standard problem, not a crew problem)',
        (spread.rows[0].operators as number) >= 6,
        `${spread.rows[0].operators} distinct operators overrun on this op`,
    );

    // ------------------------------------------------------------------
    section('Signal 4 — unplanned downtime cluster on MACH-CELL1');
    // Compare downtime *rates*, not totals. A 21-day window will almost always
    // show fewer absolute hours than an 18-month one, so an absolute comparison
    // tests nothing — hours per day is the question a plant would actually ask.
    const downtime = await client.query(`
        WITH bounds AS (
            SELECT MAX(started_at) AS last_evt, MIN(started_at) AS first_evt
            FROM ignition.downtime_event
        )
        SELECT
            SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 3600) FILTER (
                WHERE started_at >= b.last_evt - INTERVAL '21 days') / 21.0 AS recent_hrs_per_day,
            SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 3600) FILTER (
                WHERE started_at < b.last_evt - INTERVAL '21 days')
                / NULLIF(EXTRACT(EPOCH FROM (b.last_evt - INTERVAL '21 days' - b.first_evt)) / 86400, 0)
                AS earlier_hrs_per_day,
            COUNT(*) FILTER (WHERE started_at >= b.last_evt - INTERVAL '21 days')::int AS recent_events
        FROM ignition.downtime_event, bounds b
        WHERE tag_path = 'Machining/Cell1/SpindleLoadPct'
        GROUP BY b.last_evt, b.first_evt
    `);
    const recentRate = num(downtime.rows[0].recent_hrs_per_day);
    const earlierRate = num(downtime.rows[0].earlier_hrs_per_day);
    check(
        'Downtime rate spikes in the final three weeks',
        recentRate > earlierRate * 5,
        `${recentRate.toFixed(2)} hrs/day in the last 21 days vs ${earlierRate.toFixed(2)} hrs/day before ` +
        `(${(recentRate / earlierRate).toFixed(0)}x, ${downtime.rows[0].recent_events} events)`,
    );

    const atRisk = await client.query(`
        SELECT COUNT(*)::int AS n FROM (
            SELECT jh.job_num
            FROM epicor.job_head jh
            JOIN epicor.job_oper jo ON jo.job_num = jh.job_num
            WHERE jh.job_closed = FALSE AND jo.wc_code = 'MACH-CELL1'
              AND jh.req_due_date <= (SELECT MAX(req_due_date) FROM epicor.job_head)
            GROUP BY jh.job_num
        ) q
    `);
    check(
        'Open jobs route through the affected work center',
        (atRisk.rows[0].n as number) > 0,
        `${atRisk.rows[0].n} open jobs with a MACH-CELL1 operation`,
    );

    // Reason text is deliberately inconsistent — a real free-text field.
    const reasonVariants = await client.query(`
        SELECT COUNT(DISTINCT reason_text)::int AS n
        FROM ignition.downtime_event WHERE tag_path = 'Machining/Cell1/SpindleLoadPct'
    `);
    check(
        'Downtime reasons are free text with inconsistent spellings',
        (reasonVariants.rows[0].n as number) >= 3,
        `${reasonVariants.rows[0].n} distinct reason strings`,
    );

    // ------------------------------------------------------------------
    section('Signal 5 — remelt returns drift');
    const returns = await client.query(`
        SELECT
            AVG(lbs_returns / NULLIF(lbs_charged, 0)) FILTER (
                WHERE poured_at < (SELECT MIN(poured_at) FROM thrive.heat) + INTERVAL '90 days') AS early,
            AVG(lbs_returns / NULLIF(lbs_charged, 0)) FILTER (
                WHERE poured_at >= (SELECT MAX(poured_at) FROM thrive.heat) - INTERVAL '90 days') AS late
        FROM thrive.heat
    `);
    const early = num(returns.rows[0].early);
    const late = num(returns.rows[0].late);
    check(
        'Returns ratio drifts upward across the dataset',
        late > early * 1.15,
        `${(early * 100).toFixed(1)}% -> ${(late * 100).toFixed(1)}% of charge weight`,
    );

    // ------------------------------------------------------------------
    section('Reconciliation layer');

    const normalize = await client.query(`
        SELECT
            xref.normalize_job_ref('J-104829')    AS canonical,
            xref.normalize_job_ref('J104829')     AS no_sep,
            xref.normalize_job_ref('104829')      AS bare,
            xref.normalize_job_ref('Job 104829')  AS prose,
            xref.normalize_job_ref('  j-104829 ') AS messy,
            xref.normalize_job_ref('')            AS blank,
            xref.normalize_job_ref(NULL)          AS null_in,
            xref.normalize_job_ref('TBD')         AS junk
    `);
    const nz = normalize.rows[0] as Record<string, string | null>;
    check(
        'normalize_job_ref() handles all four observed formats',
        nz.canonical === 'J-104829' && nz.no_sep === 'J-104829' &&
        nz.bare === 'J-104829' && nz.prose === 'J-104829' && nz.messy === 'J-104829',
        `'J-104829' | 'J104829' | '104829' | 'Job 104829' | '  j-104829 '  all -> J-104829`,
    );
    check(
        'normalize_job_ref() returns NULL for blank, NULL, and junk',
        nz.blank === null && nz.null_in === null && nz.junk === null,
        `'' -> NULL, NULL -> NULL, 'TBD' -> NULL`,
    );

    const rates = await client.query(
        `SELECT source_pair, matched, total,
                ROUND(100.0 * matched / NULLIF(total, 0), 1) AS pct
         FROM xref.match_rate ORDER BY source_pair`,
    );
    for (const row of rates.rows as Record<string, unknown>[]) {
        const pct = num(row.pct);
        check(
            `match rate: ${row.source_pair}`,
            pct > 50 && pct < 100,
            `${row.matched}/${row.total} = ${pct}%  (deliberately below 100 — real bridges are imperfect)`,
        );
    }

    const unmatched = await client.query(
        `SELECT source_pair, COUNT(*)::int AS n FROM xref.unmatched
         GROUP BY source_pair ORDER BY source_pair`,
    );
    check(
        'xref.unmatched surfaces failures rather than hiding them',
        unmatched.rows.length >= 3,
        unmatched.rows
            .map((r: Record<string, unknown>) => `${r.source_pair}: ${r.n}`)
            .join('\n        '),
    );

    const twoParts = await client.query(`
        SELECT pattern_code, COUNT(*)::int AS n FROM xref.part_pattern
        GROUP BY pattern_code HAVING COUNT(*) > 1
    `);
    check(
        'One pattern serves more than one part number',
        twoParts.rows.length > 0,
        twoParts.rows
            .map((r: Record<string, unknown>) => `${r.pattern_code} -> ${r.n} part numbers`)
            .join(', '),
    );

    const jobHeat = await client.query(`SELECT COUNT(*)::int AS n FROM xref.job_heat`);
    check(
        'Jobs resolve to Thrive heats through the pattern bridge + time window',
        (jobHeat.rows[0].n as number) > 0,
        `${jobHeat.rows[0].n} job/heat pairs resolved`,
    );

    // ------------------------------------------------------------------
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60) + '\n');

    await client.end();
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('\nverify failed to run:', err instanceof Error ? err.message : err);
    process.exit(1);
});
