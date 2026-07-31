/**
 * The anomaly dashboard.
 *
 * Detection is deterministic SQL (lib/anomalies.ts). The model contributes one
 * sentence per finding and nothing else — it cannot change a number, a severity,
 * or whether something fired. Every card hands off to the chat surface with the
 * investigating question already written, so the dashboard is a starting point
 * rather than a dead end.
 *
 * A SERVER component, and that is the whole performance story. This page used to
 * be `'use client'`, which meant it prerendered as an empty shell and could not
 * show a single number until the browser had downloaded the bundle, hydrated
 * React, run an effect, and waited on a fetch. The server was never slow — the
 * waterfall was, and it cost 6-13 seconds of spinner.
 *
 * Now the numbers are rendered here and arrive inside the HTML. The dataset is
 * pinned and seeded, so this prerenders at build time and is served as a static
 * document; `revalidate` only exists so a re-seed is picked up without a deploy.
 * Interaction that genuinely needs the client — chart hover, and topping up
 * prose on a cache miss — lives in its own small islands.
 */
import { getDashboard } from '@/lib/anomalies';
import { readDashboardNarratives } from '@/lib/narrative/dashboard';
import { ScrapTrend, WorkCenterLoad, Reconciliation } from './charts';
import { FindingsList } from './findings';
import { AppHeader, Page, Panel, ErrorBox, StatTiles, PageNote } from '../shell';

export const revalidate = 3600;

export default async function DashboardPage() {
    let data;
    try {
        data = await getDashboard();
    } catch (err) {
        return (
            <div className="flex min-h-full flex-1 flex-col">
                <AppHeader meta="unavailable" />
                <Page>
                    <ErrorBox>
                        {err instanceof Error ? err.message : 'Dashboard query failed.'}
                    </ErrorBox>
                </Page>
            </div>
        );
    }

    // Cache read only — never generation. Waiting on the model here would put
    // the blocking call straight back into the page render.
    const narratives = await readDashboardNarratives(data.findings);
    for (const f of data.findings) f.narrative = narratives?.[f.id];

    return (
        <div className="flex min-h-full flex-1 flex-col">
            <AppHeader meta={`as of ${data.as_of}`} />

            <Page>
                <div className="space-y-5">
                    {/* Headline counts. A stat tile, not a chart — three numbers
                        do not need axes. */}
                    <StatTiles
                        items={[
                            { label: 'Open jobs', value: data.counts.open_jobs },
                            { label: 'Findings', value: data.findings.length },
                            { label: 'Unreconciled', value: data.counts.unmatched },
                        ]}
                    />

                    <Panel
                        title="What changed"
                        meta={`${data.findings.length} findings · deterministic detection`}
                    >
                        <FindingsList
                            findings={data.findings}
                            narrativePending={narratives === null}
                        />
                    </Panel>

                    <div className="grid gap-5 lg:grid-cols-2">
                        <Panel title="Scrap by reason" meta="weekly, 16 weeks">
                            <ScrapTrend points={data.scrap_series} reasons={data.scrap_reasons} />
                        </Panel>

                        <Panel title="Work centre load" meta="open jobs vs effective capacity">
                            <WorkCenterLoad rows={data.load} />
                        </Panel>

                        <Panel title="Reconciliation health" meta="match rate per bridge">
                            <Reconciliation rows={data.reconciliation} />
                        </Panel>

                        <Panel title="Next due" meta={`${data.at_risk.length} open jobs`}>
                            <div className="overflow-x-auto">
                                <table className="w-full text-[0.78rem] tabular-nums">
                                    <thead>
                                        <tr className="sign text-[0.6rem] text-ink-600">
                                            <th className="rule-b pb-1 pr-3 text-left font-normal">Job</th>
                                            <th className="rule-b pb-1 pr-3 text-left font-normal">Part</th>
                                            <th className="rule-b pb-1 pr-3 text-left font-normal">Due</th>
                                            <th className="rule-b pb-1 text-right font-normal">Days</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.at_risk.slice(0, 8).map((j) => (
                                            <tr key={j.job_num} className="border-b border-shell-800">
                                                <td className="py-1.5 pr-3 font-mono text-ink-300">{j.job_num}</td>
                                                <td className="py-1.5 pr-3 font-mono text-ink-500">{j.part_num}</td>
                                                <td className="py-1.5 pr-3 font-mono text-ink-600">{j.req_due_date}</td>
                                                <td
                                                    className="py-1.5 text-right font-mono"
                                                    style={{ color: j.days_to_due <= 5 ? 'var(--color-warn)' : 'var(--color-ink-500)' }}
                                                >
                                                    {j.days_to_due}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Panel>
                    </div>

                    <PageNote>
                        Detection is deterministic SQL — z-scores against a rolling baseline, rate
                        comparisons, and persistence tests. The model writes only the italic line
                        under each finding, over numbers it did not produce.
                    </PageNote>
                </div>
            </Page>
        </div>
    );
}
