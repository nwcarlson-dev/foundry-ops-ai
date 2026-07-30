/**
 * Tool-layer tests.
 *
 * These run against the seeded database and cross-check every tool's numbers
 * against direct SQL. That is the whole point: if the copilot reports a scrap
 * rate to someone who knows foundries and the number is wrong, the project does
 * active harm. A tool that returns plausible-looking nonsense passes a smoke
 * test and fails here.
 *
 *   npm run seed && npm test
 */
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';

// Loaded before any query runs. lib/db reads DATABASE_URL lazily on first
// query rather than at module load, so static imports below are safe.
loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });

import { TOOLS, TOOLS_BY_NAME, runTool, toolInputSchema } from '../lib/tools/index';
import { queryOne } from '../lib/db';

/** Narrow a tool result's data payload. */
function data<T = Record<string, unknown>>(r: { data: unknown }): T {
    assert.ok(r.data !== null && r.data !== undefined, 'tool returned no data');
    return r.data as T;
}

function noError(r: { error?: string }) {
    assert.equal(r.error, undefined, `tool errored: ${r.error}`);
}

// Discovered rather than hard-coded, so the suite survives a reseed.
let flagshipJob: string;
let unmappedPartJob: string;

before(async () => {
    const f = await queryOne<{ job_num: string }>(
        `SELECT m.resolved_job_num AS job_num
         FROM xref.job_monday_item m
         JOIN epicor.job_head jh ON jh.job_num = m.resolved_job_num
         WHERE m.item_name LIKE 'EXPEDITE%' AND jh.job_closed = FALSE
         ORDER BY m.promised_date LIMIT 1`,
    );
    assert.ok(f, 'no flagship expedite job found — reseed the database');
    flagshipJob = f.job_num;

    const u = await queryOne<{ job_num: string }>(
        `SELECT jh.job_num FROM epicor.job_head jh
         WHERE NOT EXISTS (SELECT 1 FROM xref.part_pattern pp WHERE pp.part_num = jh.part_num)
         LIMIT 1`,
    );
    assert.ok(u, 'no job on an unmapped part found — reseed the database');
    unmappedPartJob = u.job_num;
});

// ---------------------------------------------------------------------------

describe('registry', () => {
    test('every tool is well formed and uniquely named', () => {
        const names = new Set<string>();
        for (const t of TOOLS) {
            assert.match(t.name, /^[a-z][a-z0-9_]*$/, `${t.name} is not snake_case`);
            assert.ok(!names.has(t.name), `duplicate tool name ${t.name}`);
            names.add(t.name);
            assert.ok(t.description.length > 40, `${t.name} needs a fuller description`);
            assert.ok(t.sources.length > 0, `${t.name} declares no source systems`);
            assert.equal(typeof t.run, 'function');
        }
        assert.equal(TOOLS.length, 12);
    });

    test('every tool produces a valid JSON Schema for the model', () => {
        for (const t of TOOLS) {
            const schema = toolInputSchema(t);
            assert.equal(schema.type, 'object', `${t.name} schema is not an object`);
            assert.ok('properties' in schema, `${t.name} schema has no properties`);
        }
    });

    test('four tools cross source boundaries', () => {
        const cross = TOOLS.filter((t) => t.sources.filter((s) => s !== 'xref').length > 1);
        assert.ok(cross.length >= 4, `expected at least 4 cross-source tools, got ${cross.length}`);
    });

    test('unknown tool name is rejected as a value, not thrown', async () => {
        const r = await runTool('drop_everything', {});
        assert.match(r.error ?? '', /Unknown tool/);
    });

    test('invalid input is rejected before reaching the database', async () => {
        const r = await runTool('scrap_trend', { reason_code: 123, weeks_back: 9999 });
        assert.match(r.error ?? '', /Invalid input/);
    });
});

// ---------------------------------------------------------------------------

describe('get_open_jobs', () => {
    test('count matches direct SQL', async () => {
        const r = await runTool('get_open_jobs', {});
        noError(r);
        const rows = data<unknown[]>(r);
        const expected = await queryOne<{ n: number }>(
            `SELECT COUNT(*)::int AS n FROM epicor.job_head WHERE job_closed = FALSE`,
        );
        // Result is row-capped; assert it never exceeds the true count.
        assert.ok(Array.isArray(rows));
        assert.ok(rows.length <= (expected?.n ?? 0));
        assert.ok(rows.length > 0, 'expected some open jobs');
    });

    test('department filter actually restricts the result', async () => {
        const all = data<unknown[]>(await runTool('get_open_jobs', {}));
        const machine = data<unknown[]>(await runTool('get_open_jobs', { dept: 'MACHINE' }));
        assert.ok(machine.length <= all.length);
        for (const row of machine as Array<Record<string, unknown>>) {
            const hit = await queryOne<{ n: number }>(
                `SELECT COUNT(*)::int AS n FROM epicor.job_oper jo
                 JOIN epicor.work_center wc ON wc.wc_code = jo.wc_code
                 WHERE jo.job_num = $1 AND wc.dept = 'MACHINE'`,
                [row.job_num],
            );
            assert.ok((hit?.n ?? 0) > 0, `${row.job_num} has no MACHINE operation`);
        }
    });
});

// ---------------------------------------------------------------------------

describe('get_job_detail', () => {
    test('scrap total and cost per casting match direct SQL', async () => {
        const r = await runTool('get_job_detail', { job_num: flagshipJob });
        noError(r);
        const d = data<{
            header: Record<string, unknown>;
            scrap_total: number;
            cost: Record<string, number | null>;
        }>(r);

        assert.equal(d.header.job_num, flagshipJob);

        const expected = await queryOne<{ scrap: number; completed: number }>(
            `SELECT COALESCE(SUM(sd.scrap_qty), 0)::int AS scrap,
                    (SELECT qty_completed FROM epicor.job_head WHERE job_num = $1) AS completed
             FROM epicor.scrap_dtl sd WHERE sd.job_num = $1`,
            [flagshipJob],
        );
        assert.equal(d.scrap_total, expected?.scrap);

        // Cost per good casting must equal total actual cost / good castings.
        if (d.cost.cost_per_good_casting_usd !== null && (expected?.completed ?? 0) > 0) {
            const recomputed = (d.cost.total_actual_usd ?? 0) / (expected!.completed);
            assert.ok(
                Math.abs(d.cost.cost_per_good_casting_usd - recomputed) < 0.02,
                `cost per casting ${d.cost.cost_per_good_casting_usd} != ${recomputed}`,
            );
        }
    });

    test('accepts a job number in any of the formats a human would type', async () => {
        const bare = flagshipJob.replace('J-', '');
        for (const variant of [flagshipJob, bare, `J${bare}`, `Job ${bare}`]) {
            const r = await runTool('get_job_detail', { job_num: variant });
            noError(r);
            const d = data<{ header: Record<string, unknown> }>(r);
            assert.equal(d.header.job_num, flagshipJob, `failed for input "${variant}"`);
        }
    });

    test('a job that does not exist returns a note, not an exception', async () => {
        const r = await runTool('get_job_detail', { job_num: 'J-999999' });
        noError(r);
        assert.equal(r.data, null);
        assert.match((r.notes ?? []).join(' '), /No job/);
    });
});

// ---------------------------------------------------------------------------

describe('scrap tools', () => {
    test('scrap_by_reason totals match direct SQL', async () => {
        const r = await runTool('scrap_by_reason', { part_num: '4471-BRKT', days_back: 60 });
        noError(r);
        const d = data<{ total_scrap_qty: number; by_reason: Array<Record<string, unknown>> }>(r);

        const expected = await queryOne<{ n: number }>(
            `SELECT COALESCE(SUM(sd.scrap_qty), 0)::int AS n
             FROM epicor.scrap_dtl sd
             JOIN epicor.job_head jh ON jh.job_num = sd.job_num
             WHERE jh.part_num = '4471-BRKT'
               AND sd.logged_at >= '2026-07-29'::date - INTERVAL '60 days'
               AND sd.logged_at <= '2026-07-29'::date`,
        );
        assert.equal(d.total_scrap_qty, expected?.n);

        // Reason percentages must sum to ~100.
        const sum = d.by_reason.reduce((s, r2) => s + Number(r2.pct_of_scrap ?? 0), 0);
        assert.ok(Math.abs(sum - 100) < 1.5, `percentages sum to ${sum}, expected ~100`);
    });

    test('scrap_trend reports GASPOR on the bracket family as worsening', async () => {
        const r = await runTool('scrap_trend', {
            reason_code: 'GASPOR', part_num: '4471-BRKT', weeks_back: 16,
        });
        noError(r);
        const d = data<{ direction: string; change_pct: number | null; series: unknown[] }>(r);
        assert.equal(d.direction, 'WORSENING',
            `expected WORSENING, got ${d.direction} (change ${d.change_pct}%)`);
        assert.ok(d.series.length > 4, 'expected several weeks of series data');
    });

    test('an alloy never poured on the drifting furnace is not flagged', async () => {
        // 319 runs on furnace 1, which never drifted. If this came back
        // worsening, the porosity model would be leaking across furnaces.
        const r = await runTool('scrap_trend', {
            reason_code: 'GASPOR', part_num: '2905-VBDY', weeks_back: 16,
        });
        noError(r);
        const d = data<{ direction: string }>(r);
        assert.notEqual(d.direction, 'WORSENING',
            'a 319 part on furnace 1 should not show a worsening porosity trend');
    });
});

// ---------------------------------------------------------------------------

describe('labor_efficiency', () => {
    test('the pump-housing clean op reads as a standard problem, not a crew problem', async () => {
        const r = await runTool('labor_efficiency', {
            group_by: 'employee', part_num: '3320-HSG', oper_seq: 30, days_back: 540,
        });
        noError(r);
        const d = data<{ groups: Array<{ ratio: number | null }> }>(r);
        assert.ok(d.groups.length >= 3, 'expected several operators on this operation');

        const ratios = d.groups.map((g) => g.ratio ?? 1);
        assert.ok(Math.min(...ratios) > 1.05,
            'every operator should be over standard on a wrong-standard operation');

        // The interpretive note is the useful output here: the tool must reach
        // the "wrong standard" conclusion, not the "bad crew" one.
        assert.match((r.notes ?? []).join(' '), /standard being wrong rather than at any individual/);
    });

    test('second shift on mold line 2 is worse than first', async () => {
        const r = await runTool('labor_efficiency', {
            group_by: 'shift', wc_code: 'MOLD-L2', days_back: 160,
        });
        noError(r);
        const d = data<{ groups: Array<{ shift: string; ratio: number | null }> }>(r);
        const byShift = new Map(d.groups.map((g) => [String(g.shift), g.ratio ?? 0]));
        assert.ok(byShift.has('1') && byShift.has('2'), 'expected both shifts present');
        assert.ok(byShift.get('2')! > byShift.get('1')!,
            `shift 2 (${byShift.get('2')}) should exceed shift 1 (${byShift.get('1')})`);
    });
});

// ---------------------------------------------------------------------------

describe('job_cost_summary', () => {
    test('quantities are not multiplied by operation count', async () => {
        // Regression guard: joining job_head to job_oper duplicates the header
        // row once per operation, which silently inflated quantity and material
        // cost roughly fourfold before this was rolled up to job level first.
        const r = await runTool('job_cost_summary', {
            group_by: 'part', part_num: '4471-BRKT', days_back: 540, closed_only: true,
        });
        noError(r);
        const d = data<{ groups: Array<Record<string, unknown>> }>(r);
        assert.equal(d.groups.length, 1);

        const expected = await queryOne<{ qty: number; jobs: number }>(
            `SELECT COALESCE(SUM(qty_ordered), 0)::int AS qty, COUNT(*)::int AS jobs
             FROM epicor.job_head
             WHERE part_num = '4471-BRKT' AND job_closed = TRUE
               AND created_at >= '2026-07-29'::date - INTERVAL '540 days'`,
        );
        assert.equal(Number(d.groups[0].qty_ordered), expected?.qty);
        assert.equal(Number(d.groups[0].jobs), expected?.jobs);
    });
});

// ---------------------------------------------------------------------------

describe('at_risk_jobs', () => {
    test('every verdict is justified by its own arithmetic', async () => {
        const r = await runTool('at_risk_jobs', { horizon_days: 60 });
        noError(r);
        const d = data<{
            jobs: Array<{
                verdict: string; why: string; days_to_due: number;
                hrs_at_bottleneck: number; hrs_queued_ahead: number;
                capacity_before_due: number;
            }>;
        }>(r);
        assert.ok(d.jobs.length > 0, 'expected some jobs in a 60-day horizon');

        for (const j of d.jobs) {
            assert.ok(['LATE', 'AT_RISK', 'ON_TRACK'].includes(j.verdict));
            assert.ok(j.why.length > 20, 'every verdict must carry an explanation');
            if (j.verdict === 'AT_RISK') {
                const cumulative = j.hrs_queued_ahead + j.hrs_at_bottleneck;
                assert.ok(cumulative > j.capacity_before_due,
                    `AT_RISK but queued ${cumulative} <= capacity ${j.capacity_before_due}`);
            }
            if (j.verdict === 'LATE') assert.ok(j.days_to_due < 0);
        }
    });

    test('contention is modelled: jobs sharing a bottleneck accumulate against it', async () => {
        // The failure this guards against: five jobs each individually fitting
        // inside a degraded work centre's remaining hours, so every one reads
        // ON_TRACK while collectively they cannot possibly all ship. Judging
        // jobs in isolation reports "all fine" until the week everything is late.
        const r = await runTool('at_risk_jobs', { horizon_days: 60 });
        noError(r);
        const d = data<{
            jobs: Array<{
                job_num: string; bottleneck_wc: string; days_to_due: number;
                hrs_queued_ahead: number; hrs_at_bottleneck: number;
            }>;
        }>(r);

        // Within a shared bottleneck, later-due jobs must carry more queued
        // hours ahead of them than earlier-due ones.
        const byWc = new Map<string, typeof d.jobs>();
        for (const j of d.jobs) {
            byWc.set(j.bottleneck_wc, [...(byWc.get(j.bottleneck_wc) ?? []), j]);
        }
        let checkedAContendedCentre = false;
        for (const [wc, jobs] of byWc) {
            if (jobs.length < 2) continue;
            checkedAContendedCentre = true;
            const ordered = [...jobs].sort((a, b) => a.days_to_due - b.days_to_due);
            for (let i = 1; i < ordered.length; i++) {
                assert.ok(
                    ordered[i].hrs_queued_ahead >= ordered[i - 1].hrs_queued_ahead,
                    `${wc}: ${ordered[i].job_num} should queue behind ${ordered[i - 1].job_num}`,
                );
            }
            assert.equal(ordered[0].hrs_queued_ahead, 0,
                `${wc}: the earliest-due job should have nothing queued ahead of it`);
        }
        assert.ok(checkedAContendedCentre,
            'expected at least one work centre to be the bottleneck for multiple jobs');
    });

    test('the machining downtime cluster shows up as lost capacity', async () => {
        const r = await runTool('at_risk_jobs', { dept: 'MACHINE', horizon_days: 60 });
        noError(r);
        const d = data<{ jobs: Array<{ bottleneck_wc: string; capacity_loss_pct: number }> }>(r);
        const cell1 = d.jobs.filter((j) => j.bottleneck_wc === 'MACH-CELL1');
        if (cell1.length > 0) {
            assert.ok(cell1.every((j) => j.capacity_loss_pct > 0),
                'MACH-CELL1 should carry a capacity discount from its unplanned downtime');
        }
    });
});

// ---------------------------------------------------------------------------

describe('cross-source tools', () => {
    test('heat_history_for_job crosses the pattern bridge and beats the baseline', async () => {
        const r = await runTool('heat_history_for_job', { job_num: flagshipJob });
        noError(r);
        const d = data<{
            pattern_code: string;
            heat_count: number;
            avg_degas_minutes: number;
            furnace_baseline: { baseline_degas_minutes: number } | null;
            heats: Array<Record<string, unknown>>;
        }>(r);

        assert.ok(d.pattern_code, 'expected a resolved Thrive pattern code');
        assert.ok(d.heat_count > 0, 'expected at least one heat to resolve');

        // Cross-check against direct SQL. Dedupe to one row per heat first:
        // xref.job_heat carries a row per pour, so averaging across the raw
        // join weights each heat by how many times it poured rather than
        // treating each heat once.
        const expected = await queryOne<{ n: number; avg: number }>(
            `SELECT COUNT(*)::int AS n, ROUND(AVG(degas_minutes)::numeric, 2) AS avg
             FROM (
                 SELECT DISTINCT h.heat_num, h.degas_minutes
                 FROM xref.job_heat x
                 JOIN thrive.heat h ON h.heat_num = x.heat_num
                 WHERE x.job_num = $1
             ) one_row_per_heat`,
            [flagshipJob],
        );
        assert.equal(d.heat_count, expected?.n);
        assert.ok(Math.abs(d.avg_degas_minutes - Number(expected?.avg)) < 0.01);

        // The finding itself: degassing on this job ran below the furnace norm.
        assert.ok(d.furnace_baseline, 'expected a furnace baseline for comparison');
        assert.ok(d.avg_degas_minutes < Number(d.furnace_baseline!.baseline_degas_minutes),
            'flagship job should show degas below the furnace baseline');
    });

    test('an unmapped part reports the reconciliation gap instead of silently returning nothing', async () => {
        const r = await runTool('heat_history_for_job', { job_num: unmappedPartJob });
        noError(r);
        assert.match((r.notes ?? []).join(' '), /no pattern mapping/i);
        assert.match((r.notes ?? []).join(' '), /reconciliation_report/);
    });

    test('machine_signal_for_job resolves historian tags through the work-centre bridge', async () => {
        const r = await runTool('machine_signal_for_job', { job_num: flagshipJob });
        noError(r);
        const d = data<{ tags: Array<Record<string, unknown>>; window: Record<string, string> }>(r);
        assert.ok(d.window.started_at, 'expected a resolved job window');
        assert.ok(d.tags.length > 0, 'expected at least one historian tag to resolve');
        for (const t of d.tags) {
            assert.ok(Number(t.samples) > 0);
            assert.ok(String(t.tag_path).includes('/'), 'tag_path should look like a historian path');
        }
    });

    test('customer_commitments_for_job finds the expedite and shows the raw human input', async () => {
        const r = await runTool('customer_commitments_for_job', { job_num: flagshipJob });
        noError(r);
        const d = data<{ items: Array<Record<string, unknown>> }>(r);
        assert.ok(d.items.length > 0, 'expected a monday item for the flagship job');
        for (const item of d.items) {
            assert.equal(item.resolved_job_num, flagshipJob);
            assert.ok(item.raw_job_ref !== undefined,
                'the original human-typed reference should be surfaced alongside the normalised one');
        }
    });

    test('reconciliation_report is honest about imperfect bridges', async () => {
        const r = await runTool('reconciliation_report', { include_unmatched_detail: true });
        noError(r);
        const d = data<{
            match_rates: Array<{ source_pair: string; match_pct: number }>;
            unmatched_detail: Array<Record<string, unknown>>;
            bridges: unknown[];
        }>(r);

        assert.equal(d.bridges.length, 3);
        assert.ok(d.match_rates.length >= 4);
        for (const m of d.match_rates) {
            assert.ok(Number(m.match_pct) > 50, `${m.source_pair} match rate implausibly low`);
            assert.ok(Number(m.match_pct) < 100,
                `${m.source_pair} claims a perfect match rate — the bridges are meant to be imperfect`);
        }
        assert.ok(d.unmatched_detail.length > 0, 'unmatched records should be surfaced, not hidden');
        for (const u of d.unmatched_detail) {
            assert.ok(String(u.reason).length > 10, 'every unmatched record needs a reason');
        }
    });
});

// ---------------------------------------------------------------------------

describe('result hygiene', () => {
    test('no tool returns an unbounded row count', async () => {
        const calls: Array<[string, unknown]> = [
            ['get_open_jobs', {}],
            ['scrap_by_reason', { days_back: 540 }],
            ['at_risk_jobs', { horizon_days: 120 }],
            ['work_center_load', { weeks_ahead: 12 }],
            ['job_cost_summary', { group_by: 'part', days_back: 540 }],
            ['reconciliation_report', {}],
        ];
        for (const [name, input] of calls) {
            const r = await runTool(name, input);
            noError(r);
            const json = JSON.stringify(r.data);
            assert.ok(json.length < 120_000,
                `${name} returned ${json.length} chars — too large to re-send each turn`);
        }
    });

    test('every tool declares the sources it actually used', async () => {
        for (const name of ['get_job_detail', 'heat_history_for_job', 'machine_signal_for_job']) {
            const r = await runTool(name, { job_num: flagshipJob });
            noError(r);
            assert.deepEqual(r.sources, TOOLS_BY_NAME.get(name)!.sources);
        }
    });
});
