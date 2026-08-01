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
import { DATASET_TODAY } from '@/lib/dataset';
import { Markdown } from './markdown';
import { AppFrame, PROSE, ErrorBox } from './shell';
import { SOURCE_COLOR } from './sources';

// ---------------------------------------------------------------------------

const SOURCES = [
    { id: 'epicor', label: 'Epicor', sub: 'ERP job cost', color: 'var(--color-src-epicor)' },
    { id: 'thrive', label: 'Thrive', sub: 'melt & quality', color: 'var(--color-src-thrive)' },
    { id: 'ignition', label: 'Ignition', sub: 'historian', color: 'var(--color-src-ignition)' },
    { id: 'monday', label: 'monday', sub: 'commitments', color: 'var(--color-src-monday)' },
] as const;

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

/** What the model is doing before any answer text exists. */
type Phase = 'thinking' | 'calling' | 'writing';

interface Turn {
    role: 'user' | 'assistant';
    text: string;
    tools: ToolCall[];
    /** Reasoning streamed before the answer. Cleared once the answer starts. */
    thinking?: string;
    phase?: Phase;
    /** Tool name, when phase is 'calling'. */
    phaseName?: string;
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
                        // min-w-0 so four cells share the container instead of
                        // pushing the strip past the page gutter on a phone.
                        className="min-w-0 flex-1 bg-shell-850 px-3 py-2 transition-colors duration-300"
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
                                className="sign truncate text-[0.68rem] leading-none transition-colors duration-300"
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

/**
 * What fills the gap before the answer starts.
 *
 * At high effort most of a question's wall clock is the model reasoning, and the
 * honest thing to do with that time is show it rather than hide it behind a
 * spinner — the same argument the source bus and the tool chips already make.
 * Collapsed it is a ticker of the latest reasoning; opened it is the full trace.
 */
function ThinkingStrip({ turn, seconds }: { turn: Turn; seconds: number }) {
    const [open, setOpen] = useState(false);
    const thinking = turn.thinking ?? '';

    const label =
        turn.phase === 'calling' ? `calling ${turn.phaseName ?? 'tool'}`
        : turn.phase === 'writing' ? 'writing'
        : 'thinking';

    // The tail of the reasoning, whitespace collapsed, so the line reads as a
    // ticker instead of re-wrapping the whole trace on every delta.
    const latest = thinking.replace(/\s+/g, ' ').trim().slice(-140);

    return (
        <div className="animate-rise">
            <button
                onClick={() => setOpen((v) => !v)}
                disabled={!thinking}
                className="flex w-full items-baseline gap-2.5 text-left enabled:cursor-pointer"
            >
                <span className="sign shrink-0 text-[0.6rem] text-ink-500">
                    {label}<span className="animate-blink">_</span>
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.68rem] text-ink-500">
                    {open ? '' : latest}
                </span>
                <span className="shrink-0 font-mono text-[0.64rem] text-ink-600 tabular-nums">
                    {seconds}s
                </span>
                {thinking && (
                    <span className="shrink-0 font-mono text-[0.7rem] text-ink-600">
                        {open ? '−' : '+'}
                    </span>
                )}
            </button>

            {open && thinking && (
                <div className="mt-1 ml-2 max-h-56 overflow-y-auto border-l border-shell-700 py-1 pl-3">
                    <div className="whitespace-pre-wrap font-mono text-[0.68rem] leading-relaxed text-ink-500">
                        {thinking}
                    </div>
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
    const [elapsed, setElapsed] = useState(0);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const searchParams = useSearchParams();
    const prefilled = useRef(false);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [turns, busy]);

    // A visible second count reads as progress; a static screen reads as a hang.
    useEffect(() => {
        if (!busy) return;
        setElapsed(0);
        const startedAt = Date.now();
        const id = setInterval(
            () => setElapsed(Math.round((Date.now() - startedAt) / 1000)),
            1000,
        );
        return () => clearInterval(id);
    }, [busy]);

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
                        // The answer has started, so the reasoning strip has
                        // done its job — drop it rather than leave it stacked
                        // above the reply.
                        patch((t) => ({
                            ...t,
                            text: t.text + String(ev.v),
                            thinking: '',
                            phase: undefined,
                            phaseName: undefined,
                        }));
                    } else if (ev.t === 'status') {
                        const phase = ev.phase as Phase;
                        patch((t) => ({
                            ...t,
                            phase,
                            phaseName: phase === 'calling' ? String(ev.v ?? '') : t.phaseName,
                            thinking: phase === 'thinking' && ev.v
                                ? (t.thinking ?? '') + String(ev.v)
                                : t.thinking,
                        }));
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

    // Arriving from a dashboard card: /?q=... loads the question into the
    // composer but does NOT send it. Firing it automatically spent one of a
    // visitor's daily questions on a click that never said it would, and it
    // skipped the empty state — so the framing that says this runs on synthetic
    // data never got shown to anyone who entered this way. Prefilling fixes
    // both: the intro stays on screen with the question ready to edit or send.
    // The ref guard keeps a re-render from clobbering what the visitor types.
    useEffect(() => {
        if (prefilled.current) return;
        prefilled.current = true;

        const q = searchParams.get('q');
        if (q) setInput(q);

        // Land the caret in the composer so the thing to do is unambiguous.
        // Desktop only: on a phone this throws the keyboard over the intro
        // before anyone has read what the app is.
        if (!window.matchMedia('(min-width: 40rem)').matches) return;
        const el = inputRef.current;
        el?.focus();
        if (q) el?.setSelectionRange(q.length, q.length);
    }, [searchParams]);

    const empty = turns.length === 0;

    return (
        <AppFrame
            footer={
                /* Asking is the whole point of the app, so the field is built
                   like one: a real bordered input on a raised ground that
                   brightens to brand on focus, next to a filled button.
                   Borderless text on a translucent bar read as a status strip —
                   you had to go looking for the one control that matters.
                   brand-600 is the fill role in the token set; nothing else on
                   these pages claims it.

                   Width comes from the frame, so the composer is exactly as
                   wide as the transcript above it on every screen. */
                <form
                    onSubmit={(e) => { e.preventDefault(); send(input); }}
                    className="flex items-stretch gap-2"
                >
                    <div className="flex min-w-0 flex-1 items-center gap-2 border border-shell-600 bg-shell-850 px-3 py-2.5 transition-colors focus-within:border-brand-500">
                        <span className="shrink-0 font-mono text-[0.9rem] text-brand-400">&gt;</span>
                        <input
                            ref={inputRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            disabled={busy}
                            placeholder={busy ? 'working…' : 'Ask about jobs, scrap, heats, capacity, or commitments'}
                            className="min-w-0 flex-1 bg-transparent text-[0.95rem] text-ink-100 placeholder:text-ink-500 focus:outline-none disabled:opacity-50"
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
                    </div>
                    <button
                        type="submit"
                        disabled={busy || !input.trim() || quota?.remaining === 0}
                        className="sign shrink-0 bg-brand-600 px-5 text-[0.68rem] text-ink-100 transition-colors enabled:hover:bg-brand-500 disabled:opacity-30"
                    >
                        Ask
                    </button>
                </form>
            }
        >
            {/* The source bus. It reads as header furniture, and it used to be
                rendered inside the header — which pushed the red rule 59px
                lower here than on every other route, because it is a second row
                that only this page has. It belongs to this page, so it lives in
                this page's body, immediately below the rule that now lands at
                the same Y everywhere. */}
            <SourceBus active={activeSources} live={busy} />

            {/* --- transcript ------------------------------------------------ */}
            {empty ? (
                <div className="mt-5 animate-rise">
                    <p className={`${PROSE} text-[0.95rem] leading-relaxed text-ink-300`}>
                        Four plant systems.{' '}
                        <span className="text-ink-100">No shared keys.</span>{' '}
                        Epicor knows job numbers, Thrive knows heat numbers, the Ignition
                        historian knows only tag paths and timestamps, and the monday board
                        knows whatever somebody typed into a text field. Ask a question that
                        needs more than one of them.
                    </p>
                    <p className={`${PROSE} mt-3 text-[0.82rem] leading-relaxed text-ink-500`}>
                        Built from scratch for foundry supervisors, schedulers, and quality
                        engineers. Every row is{' '}
                        <Link
                            href="/data"
                            className="text-brand-300 underline decoration-shell-600 underline-offset-2 transition-colors hover:decoration-brand-300"
                        >
                            synthetic
                        </Link>
                        , generated from a fixed seed — no real plant or customer data. Plant
                        date is pinned to {DATASET_TODAY}.
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
                <div className="mt-5 space-y-7">
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

                                {busy && i === turns.length - 1 && !turn.text && (
                                    <ThinkingStrip turn={turn} seconds={elapsed} />
                                )}

                                {turn.error && (
                                    <div className="mt-2">
                                        <ErrorBox>{turn.error}</ErrorBox>
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
        </AppFrame>
    );
}
