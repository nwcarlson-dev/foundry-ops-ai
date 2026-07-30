'use client';

/**
 * The chat surface.
 *
 * The design intent is a plant control room rather than a chat app. The element
 * that carries the project's argument is the source bus across the top: as the
 * copilot works, each of the four systems lights up when a tool actually reads
 * from it. You watch a single question reach into Epicor, then Thrive, then the
 * Ignition historian, then the monday board. That is the whole thesis, made
 * visible rather than claimed in a README.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Markdown } from './markdown';

// ---------------------------------------------------------------------------

const SOURCES = [
    { id: 'epicor', label: 'Epicor', sub: 'ERP job cost', color: 'var(--color-src-epicor)' },
    { id: 'thrive', label: 'Thrive', sub: 'melt & quality', color: 'var(--color-src-thrive)' },
    { id: 'ignition', label: 'Ignition', sub: 'historian', color: 'var(--color-src-ignition)' },
    { id: 'monday', label: 'monday', sub: 'commitments', color: 'var(--color-src-monday)' },
] as const;

const SOURCE_COLOR: Record<string, string> = {
    epicor: 'var(--color-src-epicor)',
    thrive: 'var(--color-src-thrive)',
    ignition: 'var(--color-src-ignition)',
    monday: 'var(--color-src-monday)',
    xref: 'var(--color-src-xref)',
};

const SUGGESTIONS = [
    {
        q: 'Scrap is up on the 4471 bracket. What is causing it, and is the customer expedite at risk?',
        label: 'Scrap is up on the 4471 bracket — what is causing it?',
        note: 'Needs all four systems',
        flagship: true,
    },
    {
        q: 'Which open jobs are at risk of missing their due date, and why?',
        label: 'Which open jobs are at risk, and why?',
        note: 'Epicor + Ignition',
    },
    {
        q: 'Which parts are running the most over standard hours, and is it the standard or the crew?',
        label: 'Which parts run over standard — bad standard or bad crew?',
        note: 'Epicor',
    },
    {
        q: 'How did second shift compare to first shift on efficiency over the last few months?',
        label: 'How does second shift compare to first?',
        note: 'Epicor',
    },
    {
        q: 'How well do the four source systems actually reconcile, and what does not match?',
        label: 'How well do the four systems reconcile?',
        note: 'All four + xref',
    },
];

// ---------------------------------------------------------------------------

interface ToolCall {
    id: string;
    name: string;
    sources: string[];
    input: unknown;
    done: boolean;
    ok: boolean;
    ms: number;
    summary: string;
}

interface Turn {
    role: 'user' | 'assistant';
    text: string;
    tools: ToolCall[];
    error?: string;
    usage?: { cache_read_input_tokens: number; input_tokens: number; output_tokens: number };
}

// ---------------------------------------------------------------------------

function SourceBus({ active, live }: { active: Set<string>; live: boolean }) {
    return (
        <div className="flex items-stretch gap-px bg-shell-700 rule-t rule-b">
            {SOURCES.map((s) => {
                const on = active.has(s.id);
                return (
                    <div
                        key={s.id}
                        className="flex-1 bg-shell-850 px-3 py-2 transition-colors duration-300"
                        style={on ? { background: 'color-mix(in srgb, var(--color-shell-800) 88%, white)' } : undefined}
                    >
                        <div className="flex items-center gap-2">
                            <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all duration-300 ${
                                    on && live ? 'animate-lamp' : ''
                                }`}
                                style={{
                                    color: s.color,
                                    background: on ? s.color : 'var(--color-shell-600)',
                                }}
                            />
                            <span
                                className="sign text-[0.68rem] leading-none transition-colors duration-300"
                                style={{ color: on ? s.color : 'var(--color-ink-600)' }}
                            >
                                {s.label}
                            </span>
                        </div>
                        <div className="mt-1 font-mono text-[0.6rem] text-ink-600 truncate">
                            {s.sub}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function ToolChipRow({ call }: { call: ToolCall }) {
    const [open, setOpen] = useState(false);
    const params = Object.entries((call.input ?? {}) as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null);

    return (
        <div className="animate-rise">
            <button
                onClick={() => setOpen((v) => !v)}
                className="group flex w-full items-center gap-2.5 rounded-sm border border-shell-700 bg-shell-850/70 px-2.5 py-1.5 text-left transition-colors hover:border-shell-600 hover:bg-shell-800"
            >
                {/* Source colour bars — provenance at a glance */}
                <span className="flex shrink-0 gap-[3px]">
                    {call.sources.map((s) => (
                        <span
                            key={s}
                            title={s}
                            className="block h-3.5 w-[3px] rounded-full"
                            style={{ background: SOURCE_COLOR[s] ?? 'var(--color-shell-600)' }}
                        />
                    ))}
                </span>

                <span className="font-mono text-[0.74rem] text-ink-300">{call.name}</span>

                {!call.done ? (
                    <span className="relative ml-auto h-[2px] w-10 shrink-0 overflow-hidden rounded bg-shell-700">
                        <span className="absolute inset-y-0 left-0 w-1/3 rounded bg-brand-500 animate-sweep" />
                    </span>
                ) : (
                    <>
                        <span className="ml-auto truncate font-mono text-[0.7rem] text-ink-600">
                            {call.summary}
                        </span>
                        <span className="shrink-0 font-mono text-[0.66rem] text-ink-600 tabular-nums">
                            {call.ms}ms
                        </span>
                        {!call.ok && (
                            <span className="shrink-0 text-[0.66rem]" style={{ color: 'var(--color-danger)' }}>
                                failed
                            </span>
                        )}
                    </>
                )}
                <span className="shrink-0 font-mono text-[0.7rem] text-ink-600 transition-transform group-hover:text-ink-500">
                    {open ? '−' : '+'}
                </span>
            </button>

            {open && (
                <div className="mt-1 ml-2 border-l border-shell-700 pl-3 py-1">
                    <div className="sign text-[0.6rem] text-ink-600 mb-1">
                        read from {call.sources.join(' · ') || 'nothing'}
                    </div>
                    {params.length === 0 ? (
                        <div className="font-mono text-[0.7rem] text-ink-600">no parameters</div>
                    ) : (
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                            {params.map(([k, v]) => (
                                <div key={k} className="contents">
                                    <dt className="font-mono text-[0.7rem] text-ink-600">{k}</dt>
                                    <dd className="font-mono text-[0.7rem] text-brand-300 break-all">
                                        {typeof v === 'string' ? v : JSON.stringify(v)}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    )}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------

export default function Chat() {
    const [turns, setTurns] = useState<Turn[]>([]);
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [activeSources, setActiveSources] = useState<Set<string>>(new Set());
    const [quota, setQuota] = useState<{ remaining: number; limit: number } | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const searchParams = useSearchParams();
    const autoSent = useRef(false);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [turns, busy]);

    const send = useCallback(async (question: string) => {
        const q = question.trim();
        if (!q || busy) return;

        setInput('');
        setBusy(true);
        setActiveSources(new Set());

        const history = [
            ...turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.text })),
            { role: 'user' as const, content: q },
        ];

        setTurns((prev) => [
            ...prev,
            { role: 'user', text: q, tools: [] },
            { role: 'assistant', text: '', tools: [] },
        ]);

        // Mutate only the final (assistant) turn.
        const patch = (fn: (t: Turn) => Turn) =>
            setTurns((prev) => {
                const next = [...prev];
                next[next.length - 1] = fn(next[next.length - 1]);
                return next;
            });

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: history }),
                signal: controller.signal,
            });

            if (!res.ok || !res.body) {
                const detail = await res.json().catch(() => null);
                if (res.status === 429 && typeof detail?.limit === 'number') {
                    setQuota({ remaining: 0, limit: detail.limit });
                }
                patch((t) => ({ ...t, error: detail?.error ?? `Request failed (${res.status}).` }));
                return;
            }

            // Newline-delimited JSON; a chunk can split mid-line, so buffer.
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    let ev: Record<string, unknown>;
                    try { ev = JSON.parse(line); } catch { continue; }

                    if (ev.t === 'text') {
                        patch((t) => ({ ...t, text: t.text + String(ev.v) }));
                    } else if (ev.t === 'tool_start') {
                        const sources = (ev.sources as string[]) ?? [];
                        setActiveSources((prev) => new Set([...prev, ...sources]));
                        patch((t) => ({
                            ...t,
                            tools: [...t.tools, {
                                id: String(ev.id), name: String(ev.name), sources,
                                input: ev.input, done: false, ok: true, ms: 0, summary: '',
                            }],
                        }));
                    } else if (ev.t === 'tool_end') {
                        patch((t) => ({
                            ...t,
                            tools: t.tools.map((c) => c.id === ev.id
                                ? { ...c, done: true, ok: Boolean(ev.ok), ms: Number(ev.ms), summary: String(ev.summary) }
                                : c),
                        }));
                    } else if (ev.t === 'error') {
                        patch((t) => ({ ...t, error: String(ev.message) }));
                    } else if (ev.t === 'done') {
                        patch((t) => ({ ...t, usage: ev.usage as Turn['usage'] }));
                        if (typeof ev.remaining === 'number' && typeof ev.limit === 'number') {
                            setQuota({ remaining: ev.remaining, limit: ev.limit });
                        }
                    }
                }
            }
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                patch((t) => ({ ...t, error: (err as Error).message }));
            }
        } finally {
            setBusy(false);
            abortRef.current = null;
        }
    }, [busy, turns]);

    // Arriving from a dashboard card: /?q=... fires the question once. The ref
    // guard matters — without it a re-render would resend on every pass.
    useEffect(() => {
        const q = searchParams.get('q');
        if (q && !autoSent.current) {
            autoSent.current = true;
            void send(q);
        }
    }, [searchParams, send]);

    const empty = turns.length === 0;

    return (
        <div className="flex min-h-full flex-1 flex-col">
            {/* --- header ---------------------------------------------------- */}
            <header className="rule-brand bg-shell-900/80 backdrop-blur">
                <div className="mx-auto flex max-w-4xl items-baseline gap-3 px-5 py-3">
                    <span className="h-2 w-2 rounded-full bg-brand-500" />
                    <h1 className="sign text-[0.92rem] text-ink-100">Foundry Ops Copilot</h1>
                    <nav className="ml-auto flex items-center gap-4">
                        <Link
                            href="/data"
                            className="sign text-[0.64rem] text-ink-500 transition-colors hover:text-brand-300"
                        >
                            Source data
                        </Link>
                        <Link
                            href="/schedule"
                            className="hidden sign text-[0.64rem] text-ink-500 transition-colors hover:text-brand-300 sm:inline"
                        >
                            Schedule
                        </Link>
                        <Link
                            href="/dashboard"
                            className="sign text-[0.64rem] text-ink-500 transition-colors hover:text-brand-300"
                        >
                            Plant status →
                        </Link>
                    </nav>
                </div>
                <div className="mx-auto max-w-4xl px-5 pb-3">
                    <SourceBus active={activeSources} live={busy} />
                </div>
            </header>

            {/* --- transcript ------------------------------------------------ */}
            <main className="mx-auto w-full max-w-4xl flex-1 px-5">
                {empty ? (
                    <div className="py-12 animate-rise">
                        <p className="max-w-2xl text-[0.95rem] leading-relaxed text-ink-300">
                            Four plant systems.{' '}
                            <span className="text-ink-100">No shared keys.</span>{' '}
                            Epicor knows job numbers, Thrive knows heat numbers, the Ignition
                            historian knows only tag paths and timestamps, and the monday board
                            knows whatever somebody typed into a text field. Ask a question that
                            needs more than one of them.
                        </p>
                        <p className="mt-2 font-mono text-[0.7rem] text-ink-600">
                            Synthetic data, generated on purpose. Plant date is 2026-07-29.
                        </p>

                        <div className="mt-8 space-y-px">
                            <div className="sign mb-2 text-[0.64rem] text-ink-600">Try one</div>
                            {SUGGESTIONS.map((s) => (
                                <button
                                    key={s.q}
                                    onClick={() => send(s.q)}
                                    className="group flex w-full items-center gap-3 border-l-2 bg-shell-850/50 px-3.5 py-2.5 text-left transition-all hover:bg-shell-800"
                                    style={{
                                        borderColor: s.flagship
                                            ? 'var(--color-brand-500)'
                                            : 'var(--color-shell-600)',
                                    }}
                                >
                                    <span className="flex-1 text-[0.88rem] text-ink-300 transition-colors group-hover:text-ink-100">
                                        {s.label}
                                    </span>
                                    <span className="hidden shrink-0 font-mono text-[0.64rem] text-ink-600 sm:inline">
                                        {s.note}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="space-y-7 py-7">
                        {turns.map((turn, i) =>
                            turn.role === 'user' ? (
                                <div key={i} className="animate-rise">
                                    <div className="sign mb-1.5 text-[0.6rem] text-ink-600">Asked</div>
                                    <div className="border-l-2 border-brand-500 pl-3 text-[0.95rem] text-ink-100">
                                        {turn.text}
                                    </div>
                                </div>
                            ) : (
                                <div key={i}>
                                    {turn.tools.length > 0 && (
                                        <div className="mb-4 space-y-1">
                                            {turn.tools.map((c) => <ToolChipRow key={c.id} call={c} />)}
                                        </div>
                                    )}

                                    {turn.text && (
                                        <div className="answer text-[0.93rem] text-ink-300 animate-rise">
                                            <Markdown text={turn.text} />
                                        </div>
                                    )}

                                    {busy && i === turns.length - 1 && !turn.text && turn.tools.length === 0 && (
                                        <div className="font-mono text-[0.74rem] text-ink-600">
                                            reading<span className="animate-blink">_</span>
                                        </div>
                                    )}

                                    {turn.error && (
                                        <div
                                            className="mt-2 border-l-2 px-3 py-2 text-[0.85rem]"
                                            style={{
                                                borderColor: 'var(--color-danger)',
                                                background: 'rgba(229,72,77,0.07)',
                                                color: '#f0a3a5',
                                            }}
                                        >
                                            {turn.error}
                                        </div>
                                    )}

                                    {turn.usage && (
                                        <div className="mt-3 font-mono text-[0.62rem] text-ink-600">
                                            {turn.usage.input_tokens.toLocaleString()} in ·{' '}
                                            {turn.usage.output_tokens.toLocaleString()} out
                                            {turn.usage.cache_read_input_tokens > 0 && (
                                                <> · {turn.usage.cache_read_input_tokens.toLocaleString()} cached</>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ),
                        )}
                        <div ref={bottomRef} />
                    </div>
                )}
            </main>

            {/* --- composer --------------------------------------------------- */}
            <div className="sticky bottom-0 rule-t bg-shell-900/90 backdrop-blur">
                <form
                    onSubmit={(e) => { e.preventDefault(); send(input); }}
                    className="mx-auto flex max-w-4xl items-center gap-2 px-5 py-3"
                >
                    <span className="font-mono text-[0.85rem] text-brand-500">&gt;</span>
                    <input
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        disabled={busy}
                        placeholder={busy ? 'working…' : 'Ask about jobs, scrap, heats, capacity, or commitments'}
                        className="flex-1 bg-transparent text-[0.92rem] text-ink-100 placeholder:text-ink-600 focus:outline-none disabled:opacity-50"
                    />
                    {quota && quota.remaining <= 5 && (
                        <span
                            className="shrink-0 font-mono text-[0.64rem]"
                            style={{ color: quota.remaining === 0 ? 'var(--color-danger)' : 'var(--color-warn)' }}
                            title={`This demo allows ${quota.limit} questions per visitor per day.`}
                        >
                            {quota.remaining === 0
                                ? 'daily limit reached'
                                : `${quota.remaining} left today`}
                        </span>
                    )}
                    <button
                        type="submit"
                        disabled={busy || !input.trim() || quota?.remaining === 0}
                        className="sign shrink-0 border border-shell-600 px-3 py-1 text-[0.64rem] text-ink-300 transition-colors enabled:hover:border-brand-500 enabled:hover:text-brand-300 disabled:opacity-30"
                    >
                        Ask
                    </button>
                </form>
            </div>
        </div>
    );
}
