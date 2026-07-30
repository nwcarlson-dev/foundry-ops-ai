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
import type { Schedule } from '@/lib/scheduler';
import { AppHeader, Page, Panel, ErrorBox, StatTiles, Loading } from '../shell';

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
            <AppHeader
                title="Week Schedule"
                meta={data ? `week of ${data.week_start}` : 'loading…'}
            />

            <Page>
                {/* Filters in one row above the grid. */}
                <div className="mb-5 flex flex-wrap items-center gap-1">
                    <span className="sign mr-2 text-[0.6rem] text-ink-600">Department</span>
                    {['', ...DEPTS].map((d) => (
                        <button
                            key={d || 'all'}
                            onClick={() => selectDept(d)}
                            className="sign border px-2.5 py-1 text-[0.6rem] transition-colors"
                            style={{
                                borderColor: dept === d ? 'var(--color-brand-500)' : 'var(--color-shell-700)',
                                color: dept === d ? 'var(--color-brand-300)' : 'var(--color-ink-500)',
                            }}
                        >
                            {d || 'All'}
                        </button>
                    ))}
                </div>

                {error && <ErrorBox>{error}</ErrorBox>}

                {loading && !error && <Loading verb="sequencing" />}

                {data && !loading && (
                    <div className="space-y-5">
                        <StatTiles
                            items={[
                                { label: 'Scheduled', value: `${data.totals.hours_scheduled}h` },
                                { label: 'Operations', value: data.totals.operations_scheduled },
                                { label: "Didn't fit", value: `${data.totals.hours_unscheduled}h` },
                                { label: 'Finish late', value: data.totals.late_operations },
                            ]}
                        />

                        {/* --- the grid ------------------------------------ */}
                        <Panel
                            title="Deterministic sequence"
                            meta="earliest due date, family-grouped"
                            flush
                        >
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
                        </Panel>

                        {data.unscheduled.length > 0 && (
                            <Panel
                                title="Did not fit"
                                meta={`${data.totals.hours_unscheduled}h unscheduled`}
                                tone="danger"
                            >
                                <div className="space-y-2">
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
                            </Panel>
                        )}

                        {data.summary && (
                            <Panel title="What this means" meta="written by the model · schedule was not">
                                <div className="answer text-[0.88rem] text-ink-300">
                                    {data.summary.split('\n').filter(Boolean).map((p, i) => (
                                        <p key={i}>{p}</p>
                                    ))}
                                </div>
                            </Panel>
                        )}

                        <Panel title="Assumptions">
                            <ul className="space-y-1">
                                {data.assumptions.map((a, i) => (
                                    <li key={i} className="font-mono text-[0.66rem] leading-relaxed text-ink-600">
                                        — {a}
                                    </li>
                                ))}
                            </ul>
                        </Panel>
                    </div>
                )}
            </Page>
        </div>
    );
}
