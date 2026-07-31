/**
 * Weekly schedule.
 *
 * The schedule itself is produced by lib/scheduler.ts — a deterministic dispatch
 * rule against real capacity. The model is handed the finished result and asked
 * only to explain it. It cannot move an operation, change a capacity, or decide
 * what is late.
 *
 * As with the dashboard, this route never waits for that explanation. It serves
 * the sequence, plus the written summary if one is already cached. Generation
 * lives at ./narrative and is requested after the grid is on screen.
 */
import { buildSchedule } from '@/lib/scheduler';
import { readScheduleSummary } from '@/lib/narrative/schedule';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const DEPTS = ['MELT', 'MOLD', 'CORE', 'CLEAN', 'HEAT_TREAT', 'MACHINE'];

/** Shared with ./narrative so both read a request the same way. */
export function scheduleParams(url: string) {
    const params = new URL(url).searchParams;

    const deptParam = params.get('dept');
    const dept = deptParam && DEPTS.includes(deptParam) ? deptParam : undefined;

    const weekParam = params.get('week');
    const week = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? weekParam : undefined;

    return { dept, week_start: week };
}

export async function GET(request: Request) {
    try {
        const schedule = await buildSchedule(scheduleParams(request.url));

        const wantSummary = new URL(request.url).searchParams.get('explain') !== '0';
        const summary = wantSummary ? await readScheduleSummary(schedule) : null;

        return Response.json(
            { ...schedule, summary, summary_pending: wantSummary && summary === null },
            { headers: { 'Cache-Control': 'no-store' } },
        );
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : 'Schedule generation failed.' },
            { status: 500 },
        );
    }
}
