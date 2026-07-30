'use client';

/**
 * Weekly schedule.
 *
 * A grid of work centres by weekday. Each block is one operation's time on a
 * machine, sized by hours and marked where a setup was paid. The point the page
 * makes explicitly, top and bottom: the sequencing is deterministic code, and
 * the model only wrote the prose.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Schedule } from '@/lib/scheduler';

const DEPTS = ['MELT', 'MOLD', 'CORE', 'CLEAN', 'HEAT_TREAT', 'MACHINE'] as const;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/** Stable per-family colour from the validated categorical set. */
const FAMILY_COLORS = ['#4d94d1', '#c1591d', '#149180', '#8d63bf', '#6f7f8a'];
function familyColor(family: string, order: string[]): string {
    const i = order.indexOf(family);
    // A sixth family folds into neutral rather than inventing a hue.
    return i >= 0 && i < FAMILY_COLORS.length ? FAMILY_COLORS[i] : '#4a545c';
}

export default function SchedulePage() {
    const [data, setData] = useState<(Schedule & { summary: string | null }) | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dept, setDept] = useState<string>('');
    const [loading, setLoading] = useState(true);

    // State transitions on filter change happen in the click handler below, not
    // here: setting state synchronously inside an effect triggers an extra
    // render pass and is flagged by react-hooks/set-state-in-effect.
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        (async () => {
            try {
                const res = await fetch(`/api/schedule${dept ? `?dept=${dept}` : ''}`, {
                    signal: controller.signal,
                });
                const body = await res.json();
                if (cancelled) return;
                if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
                setData(body);
            } catch (e) {
                if (!cancelled && (e as Error).name !== 'AbortError') {
                    setError((e as Error).message);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; controller.abort(); };
    }, [dept]);

    const selectDept = (d: string) => {
        if (d === dept) return;
        setLoading(true);
        setError(null);
        setData(null);
        setDept(d);
    };

    // Fixed family order so a colour never migrates between operations.
    const families = data
        ? [...new Set(data.work_centres.flatMap((w) => w.segments.map((s) => s.family)))].sort()
        : [];

    return (
        <div className="flex min-h-full flex-1 flex-col">
            <header className="rule-b bg-shell-900/80 backdrop-blur">
                <div className="mx-auto flex max-w-6xl items-baseline gap-3 px-5 py-3">
                    <span className="h-2 w-2 rounded-full bg-melt-500" />
                    <h1 className="sign text-[0.92rem] text-ink-100">Week Schedule</h1>
                    <span className="hidden font-mono text-[0.68rem] text-ink-600 sm:inline">
                        {data ? `week of ${data.week_start}` : 'loading…'}
                    </span>
                    <nav className="ml-auto flex items-center gap-4">
                        <a href="https://github.com/nwcarlson-dev/foundry-ops-ai" target="_blank" rel="noreferrer"
                           className="sign text-[0.64rem] text-ink-600 transition-colors hover:text-melt-400">
                            Source
                        </a>
                        <Link href="/dashboard" className="sign text-[0.64rem] text-ink-500 transition-colors hover:text-melt-400">
                            Plant status
                        </Link>
                        <Link href="/" className="sign text-[0.64rem] text-ink-500 transition-colors hover:text-melt-400">
                            Ask →
                        </Link>
                    </nav>
                </div>
            </header>

            <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-6">
                {/* Filters in one row above the grid. */}
                <div className="mb-5 flex flex-wrap items-center gap-1">
                    <span className="sign mr-2 text-[0.6rem] text-ink-600">Department</span>
                    {['', ...DEPTS].map((d) => (
                        <button
                            key={d || 'all'}
                            onClick={() => selectDept(d)}
                            className="sign border px-2.5 py-1 text-[0.6rem] transition-colors"
                            style={{
                                borderColor: dept === d ? 'var(--color-melt-600)' : 'var(--color-shell-700)',
                                color: dept === d ? 'var(--color-melt-400)' : 'var(--color-ink-500)',
                            }}
                        >
                            {d || 'All'}
                        </button>
                    ))}
                </div>

                {error && (
                    <div className="border-l-2 px-3 py-2 text-[0.85rem]"
                         style={{ borderColor: 'var(--color-danger)', background: 'rgba(229,72,77,0.07)', color: '#f0a3a5' }}>
                        {error}
                    </div>
                )}

                {loading && !error && (
                    <div className="py-16 text-center font-mono text-[0.74rem] text-ink-600">
                        sequencing<span className="animate-blink">_</span>
                    </div>
                )}

                {data && !loading && (
                    <div className="space-y-5">
                        <div className="grid grid-cols-2 gap-px bg-shell-700 sm:grid-cols-4">
                            {[
                                { label: 'Scheduled', value: `${data.totals.hours_scheduled}h` },
                                { label: 'Operations', value: data.totals.operations_scheduled },
                                { label: "Didn't fit", value: `${data.totals.hours_unscheduled}h` },
                                { label: 'Finish late', value: data.totals.late_operations },
                            ].map((s) => (
                                <div key={s.label} className="bg-shell-850 px-4 py-3">
                                    <div className="font-display text-[1.6rem] leading-none text-ink-100 tabular-nums">
                                        {s.value}
                                    </div>
                                    <div className="sign mt-1 text-[0.6rem] text-ink-600">{s.label}</div>
                                </div>
                            ))}
                        </div>

                        {/* --- the grid ------------------------------------ */}
                        <section className="border border-shell-700 bg-shell-850/60">
                            <header className="rule-b px-4 py-2">
                                <h2 className="sign text-[0.68rem] text-ink-300">
                                    Deterministic sequence · earliest due date, family-grouped
                                </h2>
                            </header>

                            <div className="overflow-x-auto p-4">
                                <div className="min-w-[54rem]">
                                    <div className="mb-1 grid grid-cols-[7rem_repeat(5,1fr)] gap-1">
                                        <div />
                                        {DAY_NAMES.map((d, i) => (
                                            <div key={d} className="sign text-[0.6rem] text-ink-600">
                                                {d} <span className="text-ink-600/60">{data.days[i]?.slice(5)}</span>
                                            </div>
                                        ))}
                                    </div>

                                    {data.work_centres.map((wc) => (
                                        <div key={wc.wc_code}
                                             className="grid grid-cols-[7rem_repeat(5,1fr)] gap-1 border-t border-shell-800 py-1.5">
                                            <div className="pr-2">
                                                <div className="font-mono text-[0.72rem] text-ink-300">{wc.wc_code}</div>
                                                <div className="font-mono text-[0.6rem] text-ink-600">
                                                    {wc.effective_per_day}h/day
                                                    {wc.downtime_discount_pct > 0 && (
                                                        <span style={{ color: 'var(--color-danger)' }}>
                                                            {' '}−{wc.downtime_discount_pct}%
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            {[0, 1, 2, 3, 4].map((day) => {
                                                const segs = wc.segments.filter((s) => s.day === day);
                                                const used = segs.reduce((t, s) => t + s.hours, 0);
                                                return (
                                                    <div key={day} className="min-h-[2.6rem] bg-shell-900/60 p-1">
                                                        {segs.map((s, i) => (
                                                            <div
                                                                key={`${s.job_num}-${s.oper_seq}-${i}`}
                                                                title={
                                                                    `${s.job_num} op ${s.oper_seq} · ${s.part_num}\n` +
                                                                    `${s.hours}h · due ${s.due_date}` +
                                                                    `${s.changeover ? '\nsetup paid (family change)' : ''}` +
                                                                    `${s.late ? '\nfinishes after due date' : ''}`
                                                                }
                                                                className="mb-[2px] rounded-[2px] px-1.5 py-[3px] last:mb-0"
                                                                style={{
                                                                    background: `${familyColor(s.family, families)}22`,
                                                                    borderLeft: `2px solid ${familyColor(s.family, families)}`,
                                                                }}
                                                            >
                                                                <div className="flex items-baseline gap-1">
                                                                    <span className="font-mono text-[0.62rem] text-ink-300">
                                                                        {s.job_num.replace('J-', '')}
                                                                    </span>
                                                                    <span className="font-mono text-[0.58rem] text-ink-600">
                                                                        /{s.oper_seq}
                                                                    </span>
                                                                    {s.changeover && (
                                                                        <span className="font-mono text-[0.58rem]"
                                                                              style={{ color: 'var(--color-warn)' }}
                                                                              title="setup paid">⚙</span>
                                                                    )}
                                                                    {s.late && (
                                                                        <span className="font-mono text-[0.58rem]"
                                                                              style={{ color: 'var(--color-danger)' }}>late</span>
                                                                    )}
                                                                    <span className="ml-auto font-mono text-[0.58rem] text-ink-600 tabular-nums">
                                                                        {s.hours}h
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        ))}
                                                        {segs.length > 0 && (
                                                            <div className="mt-[2px] font-mono text-[0.55rem] text-ink-600 tabular-nums">
                                                                {Math.round(used * 10) / 10}/{wc.effective_per_day}h
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {families.length > 0 && (
                                <div className="rule-t flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
                                    <span className="sign text-[0.58rem] text-ink-600">Setup family</span>
                                    {families.slice(0, FAMILY_COLORS.length).map((f) => (
                                        <span key={f} className="flex items-center gap-1.5">
                                            <span className="block h-2.5 w-[3px] rounded-full"
                                                  style={{ background: familyColor(f, families) }} />
                                            <span className="font-mono text-[0.6rem] text-ink-500">{f}</span>
                                        </span>
                                    ))}
                                    <span className="font-mono text-[0.58rem] text-ink-600">⚙ = setup paid</span>
                                </div>
                            )}
                        </section>

                        {data.unscheduled.length > 0 && (
                            <section className="border border-shell-700 bg-shell-850/60">
                                <header className="rule-b px-4 py-2">
                                    <h2 className="sign text-[0.68rem]" style={{ color: 'var(--color-danger)' }}>
                                        Did not fit — {data.totals.hours_unscheduled}h
                                    </h2>
                                </header>
                                <div className="space-y-2 p-4">
                                    {data.unscheduled.map((u) => (
                                        <div key={`${u.job_num}-${u.oper_seq}`}
                                             className="border-l-2 pl-3"
                                             style={{ borderColor: 'var(--color-danger)' }}>
                                            <div className="font-mono text-[0.75rem] text-ink-300">
                                                {u.job_num} op {u.oper_seq} · {u.part_num} · {u.hours_needed}h ·
                                                due {u.due_date}
                                            </div>
                                            <div className="text-[0.78rem] text-ink-500">{u.reason}</div>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}

                        {data.summary && (
                            <section className="border border-shell-700 bg-shell-850/60">
                                <header className="rule-b flex items-baseline justify-between px-4 py-2">
                                    <h2 className="sign text-[0.68rem] text-ink-300">What this means</h2>
                                    <span className="font-mono text-[0.6rem] text-ink-600">
                                        written by the model · schedule was not
                                    </span>
                                </header>
                                <div className="answer p-4 text-[0.88rem] text-ink-300">
                                    {data.summary.split('\n').filter(Boolean).map((p, i) => (
                                        <p key={i}>{p}</p>
                                    ))}
                                </div>
                            </section>
                        )}

                        <section className="border border-shell-700 bg-shell-850/40 px-4 py-3">
                            <h2 className="sign mb-1.5 text-[0.6rem] text-ink-600">Assumptions</h2>
                            <ul className="space-y-1">
                                {data.assumptions.map((a, i) => (
                                    <li key={i} className="font-mono text-[0.66rem] leading-relaxed text-ink-600">
                                        — {a}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    </div>
                )}
            </main>
        </div>
    );
}
