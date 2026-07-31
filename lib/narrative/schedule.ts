/**
 * The schedule's written explanation.
 *
 * The schedule itself is produced by lib/scheduler.ts — a deterministic dispatch
 * rule against real capacity. The model is handed the finished result and asked
 * only to explain it. It cannot move an operation, change a capacity, or decide
 * what is late.
 *
 * The old single-slot module cache was keyed on the digest, which includes the
 * department filter — so clicking between the seven filters evicted it every
 * time and each click paid for a fresh explanation. Keyed rows in Postgres hold
 * all seven at once, and hold them across process restarts.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Schedule } from '../scheduler';
import { MODEL } from '../agent/loop';
import { readNarrative, writeNarrative } from '../narrative-cache';

/** Compact digest of the schedule for the explanation prompt. */
export function digest(s: Schedule): string {
    const centres = s.work_centres
        .filter((w) => w.hours_scheduled > 0)
        .map((w) =>
            `${w.wc_code} (${w.dept}): ${w.hours_scheduled}h scheduled, ` +
            `${w.utilization_pct}% of ${w.effective_per_day}h/day capacity` +
            (w.downtime_discount_pct > 0
                ? ` (nameplate ${w.capacity_per_day}h/day, cut ${w.downtime_discount_pct}% for unplanned downtime)`
                : '') +
            `, ${w.changeovers} setups paid, ${w.setups_saved} avoided by family grouping`)
        .join('\n');

    const missed = s.unscheduled
        .map((u) => `${u.job_num} op ${u.oper_seq} at ${u.wc_code}: ${u.hours_needed}h, due ${u.due_date}`)
        .join('\n');

    return [
        `Week of ${s.week_start}${s.dept ? ` — ${s.dept} only` : ''}.`,
        `Scheduled ${s.totals.operations_scheduled} operations / ${s.totals.hours_scheduled}h.`,
        `Did not fit: ${s.totals.operations_unscheduled} operations / ${s.totals.hours_unscheduled}h.`,
        `Scheduled to finish late: ${s.totals.late_operations}.`,
        '',
        'Work centres:', centres || '(none)',
        '',
        'Unscheduled:', missed || '(none)',
    ].join('\n');
}

export const scheduleKey = (s: Schedule) => `schedule:${digest(s)}`;

/** Cache only. Never calls the model — this is what a page load is allowed to do. */
export async function readScheduleSummary(s: Schedule): Promise<string | null> {
    return readNarrative<string>(scheduleKey(s));
}

/** Cache, or generate and persist. Only the narrative route and the warm script. */
export async function ensureScheduleSummary(s: Schedule): Promise<string | null> {
    const cached = await readScheduleSummary(s);
    if (cached) return cached;
    if (!process.env.ANTHROPIC_API_KEY) return null;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 900,
        output_config: { effort: 'low' },
        system:
            'You explain a production schedule to a foundry scheduler. The schedule was produced ' +
            'by a deterministic capacity model — you are describing it, not deciding it, and you ' +
            'must not suggest a different sequence.\n\n' +
            'Write 3 short paragraphs, no headings, no bullet lists:\n' +
            '1. What the week looks like and where the constraint is.\n' +
            '2. What did not fit and the consequence of that.\n' +
            '3. What it would take to recover — overtime hours, an outside cell, or moving a date.\n\n' +
            'Assume the reader knows the plant. Do not restate every number; quote only the ones ' +
            'that carry the argument. Never invent a job, work centre, or figure.',
        messages: [{ role: 'user', content: digest(s) }],
    });

    if (response.stop_reason === 'refusal') return null;
    const text = response.content.find((b) => b.type === 'text')?.text?.trim() ?? '';
    if (!text) return null;

    await writeNarrative(scheduleKey(s), text);
    return text;
}
