/**
 * Weekly schedule.
 *
 * The sequence is produced by lib/scheduler.ts — a deterministic dispatch rule
 * against real capacity — and built here, on the server, so the grid arrives
 * inside the HTML. Same reasoning as the dashboard: this page was previously a
 * client component that rendered an empty shell and could show nothing until
 * the bundle had downloaded, hydrated, and completed a fetch.
 *
 * Only the department filter is a real client interaction, so only it lives in
 * ./view. The unfiltered week that everyone lands on costs no request at all.
 */
import { buildSchedule } from '@/lib/scheduler';
import { readScheduleSummary } from '@/lib/narrative/schedule';
import { AppHeader, Page, ErrorBox } from '../shell';
import { ScheduleView } from './view';

export const revalidate = 3600;

export default async function SchedulePage() {
    let schedule;
    try {
        schedule = await buildSchedule({});
    } catch (err) {
        return (
            <div className="flex min-h-full flex-1 flex-col">
                <AppHeader meta="unavailable" />
                <Page>
                    <ErrorBox>
                        {err instanceof Error ? err.message : 'Schedule generation failed.'}
                    </ErrorBox>
                </Page>
            </div>
        );
    }

    // Cache read only. Generating here would put a model call back on the
    // critical path for every visitor, which is what this change removed.
    const summary = await readScheduleSummary(schedule);

    return (
        <div className="flex min-h-full flex-1 flex-col">
            <AppHeader meta={`week of ${schedule.week_start}`} />
            <ScheduleView
                initial={{ ...schedule, summary, summary_pending: summary === null }}
            />
        </div>
    );
}
