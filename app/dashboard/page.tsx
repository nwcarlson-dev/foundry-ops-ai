'use client';

/**
 * The anomaly dashboard.
 *
 * Detection is deterministic SQL (lib/anomalies.ts). The model contributes one
 * sentence per finding and nothing else — it cannot change a number, a severity,
 * or whether something fired. Every card hands off to the chat surface with the
 * investigating question already written, so the dashboard is a starting point
 * rather than a dead end.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Dashboard, Finding, Severity } from '@/lib/anomalies';
import { ScrapTrend, WorkCenterLoad, Reconciliation } from './charts';

const SEVERITY_STYLE: Record<Severity, { color: string; label: string }> = {
    critical: { color: 'var(--color-danger)', label: 'Critical' },
    warning: { color: 'var(--color-warn)', label: 'Warning' },
    watch: { color: 'var(--color-src-xref)', label: 'Watch' },
};

const SOURCE_COLOR: Record<string, string> = {
    epicor: 'var(--color-src-epicor)',
    thrive: 'var(--color-src-thrive)',
    ignition: 'var(--color-src-ignition)',
    monday: 'var(--color-src-monday)',
    xref: 'var(--color-src-xref)',
};

function Panel({ title, meta, children }: {
    title: string; meta?: string; children: React.ReactNode;
}) {
    return (
        <section className="border border-shell-700 bg-shell-850/60">
            <header className="flex items-baseline justify-between rule-b px-4 py-2">
                <h2 className="sign text-[0.68rem] text-ink-300">{title}</h2>
                {meta && <span className="font-mono text-[0.64rem] text-ink-600">{meta}</span>}
            </header>
            <div className="p-4">{children}</div>
        </section>
    );
}

function FindingCard({ finding }: { finding: Finding }) {
    const style = SEVERITY_STYLE[finding.severity];
    return (
        <article
            className="animate-rise border-l-2 bg-shell-850/50 px-4 py-3"
            style={{ borderColor: style.color }}
        >
            <div className="flex items-center gap-2">
                {/* Status carries an icon + label, never colour alone. */}
                <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: style.color }}
                />
                <span className="sign text-[0.6rem]" style={{ color: style.color }}>
                    {style.label}
                </span>
                <span className="ml-auto flex gap-[3px]" title={finding.sources.join(', ')}>
                    {finding.sources.map((s) => (
                        <span key={s} className="block h-3 w-[3px] rounded-full"
                              style={{ background: SOURCE_COLOR[s] }} />
                    ))}
                </span>
            </div>

            <h3 className="mt-1.5 text-[0.92rem] text-ink-100">{finding.title}</h3>
            <p className="mt-1 text-[0.82rem] leading-relaxed text-ink-300">{finding.detail}</p>

            {finding.narrative && (
                <p className="mt-2 border-l border-shell-600 pl-2.5 text-[0.82rem] italic leading-relaxed text-ink-500">
                    {finding.narrative}
                </p>
            )}

            <Link
                href={`/?q=${encodeURIComponent(finding.ask)}`}
                className="mt-2.5 inline-block sign text-[0.6rem] text-ink-500 transition-colors hover:text-brand-300"
            >
                Ask about this →
            </Link>
        </article>
    );
}

export default function DashboardPage() {
    const [data, setData] = useState<Dashboard | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch('/api/dashboard')
            .then(async (r) => {
                const body = await r.json();
                if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
                return body as Dashboard;
            })
            .then(setData)
            .catch((e: Error) => setError(e.message));
    }, []);

    return (
        <div className="flex min-h-full flex-1 flex-col">
            <header className="rule-brand bg-shell-900/80 backdrop-blur">
                <div className="mx-auto flex max-w-5xl items-baseline gap-3 px-5 py-3">
                    <span className="h-2 w-2 rounded-full bg-brand-500" />
                    <h1 className="sign text-[0.92rem] text-ink-100">Plant Status</h1>
                    <span className="hidden font-mono text-[0.68rem] text-ink-600 sm:inline">
                        {data ? `as of ${data.as_of}` : 'loading…'}
                    </span>
                    <nav className="ml-auto flex items-center gap-4">
                        <Link href="/data" className="sign text-[0.64rem] text-ink-500 transition-colors hover:text-brand-300">
                            Source data
                        </Link>
                        <Link href="/schedule" className="sign text-[0.64rem] text-ink-500 transition-colors hover:text-brand-300">
                            Schedule
                        </Link>
                        <Link href="/" className="sign text-[0.64rem] text-ink-500 transition-colors hover:text-brand-300">
                            Ask a question →
                        </Link>
                    </nav>
                </div>
            </header>

            <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-6">
                {error && (
                    <div className="border-l-2 px-3 py-2 text-[0.85rem]"
                         style={{ borderColor: 'var(--color-danger)', background: 'rgba(229,72,77,0.07)', color: '#f0a3a5' }}>
                        {error}
                    </div>
                )}

                {!data && !error && (
                    <div className="py-16 text-center font-mono text-[0.74rem] text-ink-600">
                        reading four systems<span className="animate-blink">_</span>
                    </div>
                )}

                {data && (
                    <div className="space-y-5">
                        {/* Headline counts. A stat tile, not a chart — three numbers
                            do not need axes. */}
                        <div className="grid grid-cols-3 gap-px bg-shell-700">
                            {[
                                { label: 'Open jobs', value: data.counts.open_jobs },
                                { label: 'Findings', value: data.findings.length },
                                { label: 'Unreconciled', value: data.counts.unmatched },
                            ].map((s) => (
                                <div key={s.label} className="bg-shell-850 px-4 py-3">
                                    <div className="font-display text-[1.7rem] leading-none text-ink-100 tabular-nums">
                                        {s.value}
                                    </div>
                                    <div className="sign mt-1 text-[0.6rem] text-ink-600">{s.label}</div>
                                </div>
                            ))}
                        </div>

                        <Panel
                            title="What changed"
                            meta={`${data.findings.length} findings · deterministic detection`}
                        >
                            {data.findings.length === 0 ? (
                                <p className="font-mono text-[0.72rem] text-ink-600">
                                    Nothing crossed a threshold.
                                </p>
                            ) : (
                                <div className="space-y-2">
                                    {data.findings.map((f) => <FindingCard key={f.id} finding={f} />)}
                                </div>
                            )}
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

                        <p className="font-mono text-[0.64rem] leading-relaxed text-ink-600">
                            Detection is deterministic SQL — z-scores against a rolling baseline, rate
                            comparisons, and persistence tests. The model writes only the italic line
                            under each finding, over numbers it did not produce.
                        </p>
                    </div>
                )}
            </main>
        </div>
    );
}
