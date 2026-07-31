'use client';

/**
 * The findings list.
 *
 * A client component only so it can top itself up: if the model's one-line
 * notes were not in the cache when the page rendered, it asks for them once and
 * merges them in. Everything else here is ordinary markup.
 *
 * Being a client component costs nothing at first paint — React still renders
 * this to HTML on the server, so the findings, their severities and their facts
 * are in the document before any JavaScript runs. Only the top-up needs
 * hydration, and only in the rare case the cache missed.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Finding, Severity } from '@/lib/anomalies';
import { SOURCE_COLOR } from '../sources';

const SEVERITY_STYLE: Record<Severity, { color: string; label: string }> = {
    critical: { color: 'var(--color-danger)', label: 'Critical' },
    warning: { color: 'var(--color-warn)', label: 'Warning' },
    watch: { color: 'var(--color-src-xref)', label: 'Watch' },
};

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

export function FindingsList({
    findings: initial,
    narrativePending,
}: {
    findings: Finding[];
    /** True when the page rendered before any prose had been written. */
    narrativePending: boolean;
}) {
    const [findings, setFindings] = useState(initial);

    useEffect(() => {
        if (!narrativePending) return;
        let cancelled = false;

        (async () => {
            try {
                const res = await fetch('/api/dashboard/narrative');
                if (!res.ok || cancelled) return;
                const { narratives } = await res.json() as { narratives: Record<string, string> };
                if (cancelled || !narratives) return;
                setFindings((prev) => prev.map((f) => ({ ...f, narrative: narratives[f.id] })));
            } catch {
                // The numbers are already on screen. Prose is the only thing at
                // stake, and it is not worth an error state.
            }
        })();

        return () => { cancelled = true; };
    }, [narrativePending]);

    if (findings.length === 0) {
        return (
            <p className="font-mono text-[0.72rem] text-ink-600">Nothing crossed a threshold.</p>
        );
    }

    return (
        <div className="space-y-2">
            {findings.map((f) => <FindingCard key={f.id} finding={f} />)}
        </div>
    );
}
