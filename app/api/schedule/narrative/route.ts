/**
 * The schedule's written explanation, generated on demand.
 *
 * Same split as the dashboard: the grid paints from deterministic output, and
 * this fills in the prose afterwards. The schedule is rebuilt here from the
 * query string rather than posted in, so the model only ever describes a
 * sequence this server produced.
 */
import { buildSchedule } from '@/lib/scheduler';
import { ensureScheduleSummary } from '@/lib/narrative/schedule';
import { scheduleParams } from '../route';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
    try {
        const schedule = await buildSchedule(scheduleParams(request.url));
        const summary = await ensureScheduleSummary(schedule);
        return Response.json(
            { summary },
            { headers: { 'Cache-Control': 'no-store' } },
        );
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : 'Summary generation failed.' },
            { status: 500 },
        );
    }
}
