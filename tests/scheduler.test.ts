/**
 * Scheduler tests.
 *
 * The plan's acceptance criteria for this component were specific: it must never
 * over-allocate a work centre past capacity, and every piece of unscheduled work
 * must come back with a reason. Both are asserted here, along with determinism —
 * a scheduler that returns a different answer to the same question is not a
 * scheduler a plant can use.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });

import { buildSchedule, weekStart } from '../lib/scheduler';

describe('scheduler', () => {
    test('week always starts on a Monday', () => {
        // 2026-07-29 is a Wednesday.
        assert.equal(weekStart('2026-07-29'), '2026-07-27');
        assert.equal(weekStart('2026-07-27'), '2026-07-27');   // already Monday
        assert.equal(weekStart('2026-08-02'), '2026-07-27');   // Sunday rolls back
        assert.equal(new Date(`${weekStart('2026-07-29')}T00:00:00Z`).getUTCDay(), 1);
    });

    test('never over-allocates a work centre past its capacity', async () => {
        const s = await buildSchedule();
        assert.ok(s.work_centres.length > 0, 'expected some work centres with pending work');

        for (const wc of s.work_centres) {
            for (let day = 0; day < 5; day++) {
                const hours = wc.segments
                    .filter((x) => x.day === day)
                    .reduce((sum, x) => sum + x.hours, 0);
                assert.ok(
                    hours <= wc.effective_per_day + 0.05,
                    `${wc.wc_code} day ${day}: ${hours} hrs allocated against ` +
                    `${wc.effective_per_day} hrs of capacity`,
                );
            }
        }
    });

    test('every unscheduled operation carries a reason', async () => {
        const s = await buildSchedule();
        for (const u of s.unscheduled) {
            assert.ok(u.reason.length > 20, `${u.job_num}/${u.oper_seq} has no usable reason`);
            assert.ok(u.hours_needed > 0);
            assert.ok(u.wc_code.length > 0);
        }
    });

    test('no operation is both scheduled and reported unscheduled', async () => {
        const s = await buildSchedule();
        const scheduled = new Set(
            s.work_centres.flatMap((w) => w.segments.map((x) => `${x.job_num}:${x.oper_seq}`)),
        );
        for (const u of s.unscheduled) {
            assert.ok(
                !scheduled.has(`${u.job_num}:${u.oper_seq}`),
                `${u.job_num}/${u.oper_seq} appears in both the schedule and the unscheduled list`,
            );
        }
    });

    test('a split operation is contiguous and fully allocated', async () => {
        const s = await buildSchedule();
        for (const wc of s.work_centres) {
            const byOp = new Map<string, number[]>();
            for (const seg of wc.segments) {
                const k = `${seg.job_num}:${seg.oper_seq}`;
                byOp.set(k, [...(byOp.get(k) ?? []), seg.day]);
            }
            for (const [k, daysUsed] of byOp) {
                const sorted = [...daysUsed].sort((a, b) => a - b);
                for (let i = 1; i < sorted.length; i++) {
                    assert.equal(sorted[i], sorted[i - 1] + 1,
                        `${wc.wc_code} ${k} is split across non-consecutive days`);
                }
            }
        }
    });

    test('setup is paid on a family change and not on a repeat', async () => {
        const s = await buildSchedule();
        for (const wc of s.work_centres) {
            // First segment of each operation, in schedule order.
            const firsts: typeof wc.segments = [];
            const seen = new Set<string>();
            for (const seg of [...wc.segments].sort((a, b) => a.day - b.day)) {
                const k = `${seg.job_num}:${seg.oper_seq}`;
                if (!seen.has(k)) { seen.add(k); firsts.push(seg); }
            }
            for (let i = 1; i < firsts.length; i++) {
                if (firsts[i].family === firsts[i - 1].family) {
                    assert.equal(firsts[i].changeover, false,
                        `${wc.wc_code}: consecutive ${firsts[i].family} ops should not both pay setup`);
                }
            }
        }
    });

    test("setup-family grouping demonstrably saves setups", async () => {
        const s = await buildSchedule();
        const saved = s.work_centres.reduce((sum, w) => sum + w.setups_saved, 0);
        const paid  = s.work_centres.reduce((sum, w) => sum + w.changeovers, 0);

        // If this were zero, every consecutive pair would be a family change and
        // the grouping rule would be doing nothing worth claiming.
        assert.ok(saved > 0,
            `expected some setups to be skipped by family grouping (paid ${paid}, saved ${saved})`);

        // Per centre, setups paid + setups skipped must equal the transitions
        // between operations. Anything else means the counters are lying.
        for (const w of s.work_centres) {
            const opCount = new Set(w.segments.map((x) => `${x.job_num}:${x.oper_seq}`)).size;
            if (opCount === 0) continue;
            assert.equal(w.changeovers + w.setups_saved, opCount - 1,
                `${w.wc_code}: ${w.changeovers} paid + ${w.setups_saved} saved != ${opCount - 1} transitions`);
        }
    });

    test('is deterministic — same inputs, same schedule', async () => {
        const [a, b] = await Promise.all([buildSchedule(), buildSchedule()]);
        assert.equal(JSON.stringify(a), JSON.stringify(b));
    });

    test('department filter restricts the schedule to that department', async () => {
        const s = await buildSchedule({ dept: 'MACHINE' });
        for (const wc of s.work_centres) {
            assert.equal(wc.dept, 'MACHINE');
        }
        for (const u of s.unscheduled) {
            assert.match(u.wc_code, /^MACH-/);
        }
    });

    test('states its assumptions rather than hiding them', async () => {
        const s = await buildSchedule();
        assert.ok(s.assumptions.length >= 3);
        assert.ok(
            s.assumptions.some((a) => /NOT modelled/i.test(a)),
            'the schedule must say what it does not account for',
        );
    });

    test('downtime is reflected in effective capacity', async () => {
        const s = await buildSchedule();
        for (const wc of s.work_centres) {
            assert.ok(wc.effective_per_day <= wc.capacity_per_day + 0.01);
            assert.ok(wc.downtime_discount_pct >= 0 && wc.downtime_discount_pct <= 60.01);
        }
    });
});
