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
import type { Schedule, Segment } from '@/lib/scheduler';
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

/**
 * One operation's time on a machine.
 *
 * Shared by the week grid and the phone day list. `roomy` is the phone: with no
 * column pressure there is no reason to keep the type at the 9px the grid needs,
 * and the part number and due date fit without a hover title nobody on a
 * touchscreen can trigger.
 */
function SegmentBlock({
    seg,
    families,
    roomy = false,
}: {
    seg: Segment;
    families: string[];
    roomy?: boolean;
}) {
    const color = familyColor(seg.family, families);

    return (
        <div
            title={
                `${seg.job_num} op ${seg.oper_seq} · ${seg.part_num}\n` +
                `${seg.hours}h · due ${seg.due_date}` +
                `${seg.changeover ? '\nsetup paid (family change)' : ''}` +
                `${seg.late ? '\nfinishes after due date' : ''}`
            }
            className={`rounded-[2px] ${roomy ? 'px-2 py-1.5' : 'px-1.5 py-[3px]'}`}
            style={{ background: `${color}22`, borderLeft: `2px solid ${color}` }}
        >
            <div className="flex items-baseline gap-1">
                <span className={`font-mono text-ink-300 ${roomy ? 'text-[0.8rem]' : 'text-[0.62rem]'}`}>
                    {seg.job_num.replace('J-', '')}
                </span>
                <span className={`font-mono ${roomy ? 'text-[0.72rem] text-ink-500' : 'text-[0.58rem] text-ink-600'}`}>
                    /{seg.oper_seq}
                </span>
                {seg.changeover && (
                    <span
                        className={`font-mono ${roomy ? 'text-[0.72rem]' : 'text-[0.58rem]'}`}
                        style={{ color: 'var(--color-warn)' }}
                        title="setup paid"
                    >
                        ⚙
                    </span>
                )}
                {seg.late && (
                    <span
                        className={`font-mono ${roomy ? 'text-[0.72rem]' : 'text-[0.58rem]'}`}
                        style={{ color: 'var(--color-danger)' }}
                    >
                        late
                    </span>
                )}
                <span
                    className={`ml-auto font-mono tabular-nums ${
                        roomy ? 'text-[0.72rem] text-ink-500' : 'text-[0.58rem] text-ink-600'
                    }`}
                >
                    {seg.hours}h
                </span>
            </div>
            {roomy && (
                <div className="mt-0.5 font-mono text-[0.68rem] text-ink-500">
                    {seg.part_num} · due {seg.due_date}
                </div>
            )}
        </div>
    );
}

export default function SchedulePage() {
    const [data, setData] = useState<(Schedule & { summary: string | null }) | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dept, setDept] = useState<string>('');
    const [loading, setLoading] = useState(true);
    /** Phone only: the week grid does not fit, so it shows one weekday. */
    const [day, setDay] = useState(0);

    // State transitions on filter change happen in the click handler below, not
    // here: setting state synchronously inside an effect triggers an extra
    // render pass and is flagged by react-hooks/set-state-in-effect.
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        (async () => {
            const q = dept ? `?dept=${dept}` : '';
            try {
                const res = await fetch(`/api/schedule${q}`, { signal: controller.signal });
                const body = await res.json();
                if (cancelled) return;
                if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
                setData(body);
                setLoading(false);

                // Grid is up. Fetch the written explanation separately, and only
                // when it was not already cached — waiting on it before showing
                // the sequence made every department click cost a model call.
                if (!body.summary_pending) return;

                const sr = await fetch(`/api/schedule/narrative${q}`, { signal: controller.signal });
                if (!sr.ok || cancelled) return;
                const { summary } = await sr.json() as { summary: string | null };
                if (cancelled || !summary) return;
                setData((prev) => prev && { ...prev, summary });
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

    // Phone view: only the work centres that actually run on the selected day.
    // An empty machine is a row worth skipping when there is one column to read.
    const dayCentres = (data?.work_centres ?? [])
        .map((wc) => {
            const segs = wc.segments.filter((s) => s.day === day);
            return { wc, segs, used: segs.reduce((t, s) => t + s.hours, 0) };
        })
        .filter((r) => r.segs.length > 0);

    return (
        <div className="flex min-h-full flex-1 flex-col">
            <AppHeader meta={data ? `week of ${data.week_start}` : 'loading…'} />

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
                            {/* Phone: one weekday at a time. The grid needs 54rem
                                to stay legible, and dragging a week sideways on
                                the screen a floor person actually carries is the
                                worst version of this page. */}
                            <div className="sm:hidden">
                                <div className="rule-b flex gap-1 px-3 py-2">
                                    {DAY_NAMES.map((d, i) => (
                                        <button
                                            key={d}
                                            onClick={() => setDay(i)}
                                            aria-pressed={day === i}
                                            className="sign flex-1 border py-2 text-[0.62rem] transition-colors"
                                            style={{
                                                borderColor: day === i
                                                    ? 'var(--color-brand-500)'
                                                    : 'var(--color-shell-700)',
                                                color: day === i
                                                    ? 'var(--color-brand-300)'
                                                    : 'var(--color-ink-500)',
                                            }}
                                        >
                                            {d}
                                        </button>
                                    ))}
                                </div>

                                <div className="space-y-2 px-3 py-3">
                                    <div className="sign text-[0.6rem] text-ink-500">
                                        {DAY_NAMES[day]} {data.days[day]?.slice(5)}
                                    </div>
                                    {dayCentres.length === 0 ? (
                                        <p className="font-mono text-[0.72rem] text-ink-500">
                                            Nothing scheduled on {DAY_NAMES[day]}.
                                        </p>
                                    ) : (
                                        dayCentres.map(({ wc, segs, used }) => (
                                            <div
                                                key={wc.wc_code}
                                                className="border border-shell-700 bg-shell-900/60 p-2.5"
                                            >
                                                <div className="mb-2 flex items-baseline gap-2">
                                                    <span className="font-mono text-[0.82rem] text-ink-300">
                                                        {wc.wc_code}
                                                    </span>
                                                    {wc.downtime_discount_pct > 0 && (
                                                        <span
                                                            className="font-mono text-[0.68rem]"
                                                            style={{ color: 'var(--color-danger)' }}
                                                        >
                                                            −{wc.downtime_discount_pct}%
                                                        </span>
                                                    )}
                                                    <span className="ml-auto font-mono text-[0.72rem] text-ink-500 tabular-nums">
                                                        {Math.round(used * 10) / 10}/{wc.effective_per_day}h
                                                    </span>
                                                </div>
                                                <div className="space-y-1">
                                                    {segs.map((s, i) => (
                                                        <SegmentBlock
                                                            key={`${s.job_num}-${s.oper_seq}-${i}`}
                                                            seg={s}
                                                            families={families}
                                                            roomy
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>

                            {/* Tablet and up: the week grid. It still scrolls on
                                narrow screens, so the work-centre column is
                                pinned and the right edge is faded — you always
                                know which row you are reading, and that there
                                is more week to the right. */}
                            <div className="relative hidden sm:block">
                                <div className="overflow-x-auto p-4">
                                    <div className="min-w-[54rem]">
                                        <div className="mb-1 grid grid-cols-[7rem_repeat(5,1fr)] gap-1">
                                            <div className="sticky left-0 z-10 bg-shell-850" />
                                            {DAY_NAMES.map((d, i) => (
                                                <div key={d} className="sign text-[0.6rem] text-ink-600">
                                                    {d} <span className="text-ink-600/60">{data.days[i]?.slice(5)}</span>
                                                </div>
                                            ))}
                                        </div>

                                        {data.work_centres.map((wc) => (
                                            <div key={wc.wc_code}
                                                 className="grid grid-cols-[7rem_repeat(5,1fr)] gap-1 border-t border-shell-800 py-1.5">
                                                <div className="sticky left-0 z-10 bg-shell-850 pr-2">
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

                                                {[0, 1, 2, 3, 4].map((d) => {
                                                    const segs = wc.segments.filter((s) => s.day === d);
                                                    const used = segs.reduce((t, s) => t + s.hours, 0);
                                                    return (
                                                        <div key={d} className="min-h-[2.6rem] space-y-[2px] bg-shell-900/60 p-1">
                                                            {segs.map((s, i) => (
                                                                <SegmentBlock
                                                                    key={`${s.job_num}-${s.oper_seq}-${i}`}
                                                                    seg={s}
                                                                    families={families}
                                                                />
                                                            ))}
                                                            {segs.length > 0 && (
                                                                <div className="font-mono text-[0.55rem] text-ink-600 tabular-nums">
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

                                {/* Scroll affordance. Decorative, so it must not
                                    eat pointer events on the cells beneath it. */}
                                <div
                                    aria-hidden
                                    className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-shell-850 to-transparent lg:hidden"
                                />
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
