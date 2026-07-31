'use client';

/**
 * Charts, hand-rolled as SVG.
 *
 * Two rules from the dataviz method drive everything here: the form follows the
 * data's job (change-over-time gets a line, magnitude-against-a-limit gets a
 * bar), and colour is assigned last, from a palette validated with the checker
 * rather than picked by eye. Categorical hues are assigned in fixed order and
 * never cycled — a fifth scrap code folds into the total rather than inventing
 * a hue.
 *
 * Every series is direct-labelled as well as coloured, so identity never rests
 * on colour alone.
 */
import { useId, useState } from 'react';
import type { ScrapPoint, LoadRow, MatchRow } from '@/lib/anomalies';

/** Fixed categorical order. Validated for CVD against the dark chart surface. */
const SERIES_COLORS = ['#c1591d', '#4d94d1', '#149180', '#8d63bf'];

const AXIS = '#3d464e';
const GRID = '#21262b';
const INK_MUTED = '#7c878f';

// ---------------------------------------------------------------------------

export function ScrapTrend({ points, reasons }: { points: ScrapPoint[]; reasons: string[] }) {
    const clipId = useId();
    const [hover, setHover] = useState<number | null>(null);

    const weeks = [...new Set(points.map((p) => p.week))].sort();
    if (weeks.length < 2 || reasons.length === 0) {
        return <Empty label="Not enough scrap history to plot." />;
    }

    const byReason = new Map(
        reasons.map((code) => [
            code,
            weeks.map((w) => points.find((p) => p.week === w && p.reason_code === code)?.qty ?? 0),
        ]),
    );

    const max = Math.max(1, ...[...byReason.values()].flat());
    const W = 720, H = 210, PAD_L = 34, PAD_R = 76, PAD_T = 12, PAD_B = 26;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const x = (i: number) => PAD_L + (i / (weeks.length - 1)) * plotW;
    const y = (v: number) => PAD_T + plotH - (v / max) * plotH;

    const ticks = [0, Math.round(max / 2), max];
    const shortWeek = (w: string) => w.slice(5).replace('-', '/');

    /**
     * Series-end labels, pushed apart so they stay readable where the lines
     * converge — the right edge is exactly where scrap codes tend to meet.
     *
     * Sort by ideal position, walk down enforcing a minimum gap, then walk back
     * up if the stack ran past the bottom of the plot. Two passes is enough for
     * four labels and keeps the order matching the lines.
     */
    const LABEL_GAP = 11;
    const placeLabels = (() => {
        const items = reasons.map((code, si) => {
            const values = byReason.get(code)!;
            return { code, si, anchorY: y(values[values.length - 1]) };
        });

        const sorted = [...items].sort((a, b) => a.anchorY - b.anchorY);
        const placed = sorted.map((it) => ({ ...it, labelY: it.anchorY }));

        for (let i = 1; i < placed.length; i++) {
            const gap = placed[i].labelY - placed[i - 1].labelY;
            if (gap < LABEL_GAP) placed[i].labelY = placed[i - 1].labelY + LABEL_GAP;
        }

        const bottom = PAD_T + plotH;
        const overflow = placed[placed.length - 1].labelY - bottom;
        if (overflow > 0) {
            for (const p of placed) p.labelY -= overflow;
            for (let i = placed.length - 2; i >= 0; i--) {
                const gap = placed[i + 1].labelY - placed[i].labelY;
                if (gap < LABEL_GAP) placed[i].labelY = placed[i + 1].labelY - LABEL_GAP;
            }
        }

        for (const p of placed) p.labelY = Math.max(PAD_T + 4, p.labelY);
        return placed;
    })();

    return (
        <figure className="m-0">
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full"
                role="img"
                aria-label={`Weekly scrap quantity by reason code over ${weeks.length} weeks`}
                onMouseLeave={() => setHover(null)}
            >
                <defs>
                    <clipPath id={clipId}>
                        <rect x={PAD_L} y={PAD_T} width={plotW} height={plotH} />
                    </clipPath>
                </defs>

                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={PAD_L} x2={PAD_L + plotW} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
                        <text x={PAD_L - 6} y={y(t) + 3} textAnchor="end"
                              fill={INK_MUTED} fontSize={9} fontFamily="var(--font-mono)">
                            {t}
                        </text>
                    </g>
                ))}

                {weeks.map((w, i) =>
                    i % 3 === 0 ? (
                        <text key={w} x={x(i)} y={H - 8} textAnchor="middle"
                              fill={INK_MUTED} fontSize={9} fontFamily="var(--font-mono)">
                            {shortWeek(w)}
                        </text>
                    ) : null,
                )}

                <g clipPath={`url(#${clipId})`}>
                    {reasons.map((code, si) => {
                        const values = byReason.get(code)!;
                        const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
                        return (
                            <path key={code} d={d} fill="none" stroke={SERIES_COLORS[si]}
                                  strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                        );
                    })}
                </g>

                {/* Direct labels at the series end — identity without a lookup.
                    Series converge, so the ideal positions collide and stack
                    into an unreadable pile; nudge them apart and draw a leader
                    to wherever the label had to move. */}
                {placeLabels.map(({ code, si, anchorY, labelY }) => (
                    <g key={code}>
                        {Math.abs(labelY - anchorY) > 1 && (
                            <polyline
                                points={`${PAD_L + plotW},${anchorY} ${PAD_L + plotW + 4},${labelY} ${PAD_L + plotW + 6},${labelY}`}
                                fill="none" stroke={SERIES_COLORS[si]} strokeWidth={1} opacity={0.5}
                            />
                        )}
                        <text x={PAD_L + plotW + 8} y={labelY + 3}
                              fill={SERIES_COLORS[si]} fontSize={10} fontFamily="var(--font-mono)">
                            {code}
                        </text>
                    </g>
                ))}

                {/* Crosshair + hit targets */}
                {hover !== null && (
                    <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + plotH}
                          stroke={INK_MUTED} strokeWidth={1} strokeDasharray="2 2" />
                )}
                {weeks.map((w, i) => (
                    <rect key={w} x={x(i) - plotW / weeks.length / 2} y={PAD_T}
                          width={plotW / weeks.length} height={plotH}
                          fill="transparent" onMouseEnter={() => setHover(i)} />
                ))}
                {hover !== null &&
                    reasons.map((code, si) => (
                        <circle key={code} cx={x(hover)} cy={y(byReason.get(code)![hover])} r={3.5}
                                fill={SERIES_COLORS[si]} stroke="var(--color-chart-surface)" strokeWidth={2} />
                    ))}
            </svg>

            {hover !== null && (
                <figcaption className="mt-1 font-mono text-[0.68rem] text-ink-500">
                    week of {weeks[hover]} —{' '}
                    {reasons.map((code, si) => (
                        <span key={code} className="mr-3">
                            <span style={{ color: SERIES_COLORS[si] }}>■</span>{' '}
                            {code} {byReason.get(code)![hover]}
                        </span>
                    ))}
                </figcaption>
            )}
        </figure>
    );
}

// ---------------------------------------------------------------------------

export function WorkCenterLoad({ rows }: { rows: LoadRow[] }) {
    if (rows.length === 0) return <Empty label="No committed hours on open jobs." />;

    const max = Math.max(...rows.map((r) => Math.max(r.committed_hrs, r.effective_hrs)));

    return (
        <div className="space-y-2.5">
            {rows.slice(0, 8).map((r) => {
                const over = (r.utilization_pct ?? 0) > 100;
                const committedPct = (r.committed_hrs / max) * 100;
                const capacityPct = (r.effective_hrs / max) * 100;
                return (
                    <div key={r.wc_code}>
                        <div className="flex items-baseline justify-between">
                            <span className="font-mono text-[0.72rem] text-ink-300">{r.wc_code}</span>
                            <span
                                className="font-mono text-[0.68rem] tabular-nums"
                                style={{ color: over ? 'var(--color-danger)' : 'var(--color-ink-500)' }}
                            >
                                {r.committed_hrs}h / {r.effective_hrs}h
                                {r.utilization_pct !== null && ` · ${r.utilization_pct}%`}
                            </span>
                        </div>
                        <div className="relative mt-1 h-2.5 w-full bg-shell-800">
                            {/* Capacity marker: the limit the bar is measured against. */}
                            <div
                                className="absolute inset-y-0 w-px"
                                style={{ left: `${Math.min(100, capacityPct)}%`, background: AXIS }}
                            />
                            <div
                                className="absolute inset-y-0 left-0 rounded-r-[3px]"
                                style={{
                                    width: `${Math.min(100, committedPct)}%`,
                                    background: over ? 'var(--color-danger)' : 'var(--color-src-epicor)',
                                }}
                            />
                        </div>
                    </div>
                );
            })}
            <p className="pt-1 font-mono text-[0.64rem] text-ink-600">
                Bar is committed hours on open jobs. Tick is effective weekly capacity, after
                discounting recent unplanned downtime.
            </p>
        </div>
    );
}

// ---------------------------------------------------------------------------

export function Reconciliation({ rows }: { rows: MatchRow[] }) {
    if (rows.length === 0) return <Empty label="No reconciliation data." />;

    return (
        <div className="space-y-2.5">
            {rows.map((r) => {
                const pct = Number(r.match_pct);
                return (
                    <div key={r.source_pair}>
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="font-mono text-[0.68rem] text-ink-300 truncate">
                                {r.source_pair}
                            </span>
                            <span className="shrink-0 font-mono text-[0.68rem] tabular-nums text-ink-500">
                                {r.matched}/{r.total} · {pct}%
                            </span>
                        </div>
                        <div className="mt-1 h-2 w-full bg-shell-800">
                            <div
                                className="h-full rounded-r-[3px]"
                                style={{ width: `${pct}%`, background: 'var(--color-src-xref)' }}
                            />
                        </div>
                    </div>
                );
            })}
            <p className="pt-1 font-mono text-[0.64rem] text-ink-600">
                Below 100% on purpose. The bridges are hand-maintained and imperfect, as real
                cross-system reconciliation is.
            </p>
        </div>
    );
}

// ---------------------------------------------------------------------------

function Empty({ label }: { label: string }) {
    return (
        <div className="py-6 text-center font-mono text-[0.7rem] text-ink-600">{label}</div>
    );
}
