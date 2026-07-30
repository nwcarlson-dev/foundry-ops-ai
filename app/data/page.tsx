'use client';

/**
 * The source data, unmediated.
 *
 * Every other surface interprets these rows. This one does not — it is the
 * receipt. A visitor who suspects the copilot is inventing numbers can come
 * here and read the table it claims to have read.
 *
 * The navigator is grouped by source system rather than alphabetically, because
 * the grouping *is* the argument: four systems, four key conventions, nothing
 * shared. xref sits apart at the bottom for the same reason — it is the only
 * thing in the database that knows how the other four relate.
 */
import { useEffect, useState } from 'react';
import { AppHeader, Page, Panel, ErrorBox, PageNote, Loading } from '../shell';

interface Relation {
    schema: string;
    name: string;
    kind: 'table' | 'view';
    rows: number;
}

interface Page {
    relation: string;
    kind: 'table' | 'view';
    total: number;
    limit: number;
    offset: number;
    columns: { name: string; type: string }[];
    rows: Record<string, unknown>[];
}

const SOURCE_COLOR: Record<string, string> = {
    epicor: 'var(--color-src-epicor)',
    thrive: 'var(--color-src-thrive)',
    ignition: 'var(--color-src-ignition)',
    monday: 'var(--color-src-monday)',
    xref: 'var(--color-src-xref)',
};

/** What each schema is, in the words its own vendor would use. */
const SCHEMA_NOTE: Record<string, { label: string; keyed: string }> = {
    epicor: { label: 'ERP — job cost', keyed: 'keyed on job_num, part_num' },
    thrive: { label: 'Melt deck & quality', keyed: 'keyed on heat_num, pattern_code' },
    ignition: { label: 'SCADA historian', keyed: 'keyed on tag_path + timestamp' },
    monday: { label: 'Customer board', keyed: 'keyed on item_id; job ref is free text' },
    xref: { label: 'Reconciliation layer', keyed: 'the only thing that spans them' },
};

const SCHEMA_ORDER = ['epicor', 'thrive', 'ignition', 'monday', 'xref'];

/** Renders a cell without lying about what is in it. */
function cell(v: unknown): { text: string; muted: boolean } {
    if (v === null || v === undefined) return { text: 'NULL', muted: true };
    if (v === '') return { text: '(empty)', muted: true };
    if (typeof v === 'boolean') return { text: v ? 'true' : 'false', muted: false };
    if (v instanceof Date) return { text: v.toISOString(), muted: false };
    if (typeof v === 'object') return { text: JSON.stringify(v), muted: false };
    return { text: String(v), muted: false };
}

export default function DataPage() {
    const [relations, setRelations] = useState<Relation[] | null>(null);
    const [selected, setSelected] = useState<string>('epicor.job_head');
    const [offset, setOffset] = useState(0);
    const [page, setPage] = useState<Page | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/data')
            .then(async (r) => {
                const body = await r.json();
                if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
                return body.relations as Relation[];
            })
            .then(setRelations)
            .catch((e: Error) => setError(e.message));
    }, []);

    // The spinner is raised by whichever handler caused the change, not here:
    // setting state synchronously in an effect body triggers an extra render
    // pass and is flagged by react-hooks/set-state-in-effect.
    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;

        (async () => {
            try {
                const r = await fetch(
                    `/api/data?relation=${encodeURIComponent(selected)}&offset=${offset}`,
                    { signal: controller.signal },
                );
                const body = await r.json();
                if (cancelled) return;
                if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
                setPage(body as Page);
                setError(null);
            } catch (e) {
                if (!cancelled && (e as Error).name !== 'AbortError') {
                    setError((e as Error).message);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; controller.abort(); };
    }, [selected, offset]);

    const selectRelation = (full: string) => {
        if (full === selected) return;
        setLoading(true);
        setOffset(0);
        setSelected(full);
    };

    const goto = (next: number) => {
        setLoading(true);
        setOffset(next);
    };

    const grouped = SCHEMA_ORDER.map((s) => ({
        schema: s,
        items: (relations ?? []).filter((r) => r.schema === s),
    })).filter((g) => g.items.length > 0);

    return (
        <div className="flex min-h-full flex-1 flex-col">
            <AppHeader title="Source Data" meta={`${relations?.length ?? 0} relations · four systems`} />

            <Page>
                <p className="mb-5 max-w-[68ch] text-[0.86rem] leading-relaxed text-ink-300">
                    The four systems below share <strong className="text-ink-100">no keys</strong>.
                    Epicor knows <code className="font-mono text-brand-300">J-104829</code>.
                    Thrive knows <code className="font-mono text-brand-300">H26-0412</code> and its own
                    pattern codes. The historian knows only a tag path and a timestamp.
                    monday.com knows whatever a person typed. Read the rows and you can
                    check that for yourself — then look at <code className="font-mono text-brand-300">xref</code>,
                    which is the only thing in the database that spans them.
                </p>

                {error && <div className="mb-4"><ErrorBox>{error}</ErrorBox></div>}

                <div className="grid gap-5 lg:grid-cols-[15rem_1fr]">
                    {/* --- navigator ------------------------------------------- */}
                    <nav className="space-y-4">
                        {!relations && !error && (
                            <p className="font-mono text-[0.72rem] text-ink-600">
                                reading catalogue<span className="animate-blink">_</span>
                            </p>
                        )}
                        {grouped.map((g) => (
                            <div key={g.schema}>
                                <div className="flex items-baseline gap-2">
                                    <span className="block h-3 w-[3px] rounded-full"
                                          style={{ background: SOURCE_COLOR[g.schema] }} />
                                    <h2 className="sign text-[0.62rem]" style={{ color: SOURCE_COLOR[g.schema] }}>
                                        {g.schema}
                                    </h2>
                                </div>
                                <p className="mt-0.5 pl-[11px] font-mono text-[0.6rem] leading-snug text-ink-600">
                                    {SCHEMA_NOTE[g.schema]?.label}
                                    <br />
                                    {SCHEMA_NOTE[g.schema]?.keyed}
                                </p>
                                <ul className="mt-1.5 space-y-px">
                                    {g.items.map((r) => {
                                        const full = `${r.schema}.${r.name}`;
                                        const active = full === selected;
                                        return (
                                            <li key={full}>
                                                <button
                                                    onClick={() => selectRelation(full)}
                                                    className={`flex w-full items-baseline gap-2 px-[11px] py-1 text-left font-mono text-[0.72rem] transition-colors ${
                                                        active
                                                            ? 'bg-shell-800 text-ink-100'
                                                            : 'text-ink-500 hover:bg-shell-850 hover:text-ink-300'
                                                    }`}
                                                >
                                                    <span className="truncate">{r.name}</span>
                                                    {r.kind === 'view' && (
                                                        <span className="text-[0.58rem] text-ink-600">view</span>
                                                    )}
                                                    <span className="ml-auto tabular-nums text-[0.64rem] text-ink-600">
                                                        {r.rows.toLocaleString()}
                                                    </span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                        ))}
                    </nav>

                    {/* --- table ----------------------------------------------- */}
                    <Panel
                        flush
                        title={
                            <span className="flex items-baseline gap-2">
                                <span className="font-mono text-[0.78rem] text-ink-100">{selected}</span>
                                {page && (
                                    <span className="sign text-[0.58rem] text-ink-600">{page.kind}</span>
                                )}
                            </span>
                        }
                        meta={
                            page
                                ? page.total === 0
                                    ? 'no rows'
                                    : `${(page.offset + 1).toLocaleString()}–${Math.min(page.offset + page.limit, page.total).toLocaleString()} of ${page.total.toLocaleString()}`
                                : undefined
                        }
                    >
                        {loading && !page && <Loading verb="reading rows" />}

                        {page && (
                            <>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-[0.74rem] tabular-nums">
                                        <thead>
                                            <tr>
                                                {page.columns.map((c) => (
                                                    <th key={c.name}
                                                        className="whitespace-nowrap rule-b px-3 py-1.5 text-left font-normal">
                                                        <span className="sign block text-[0.56rem] text-ink-300">
                                                            {c.name}
                                                        </span>
                                                        <span className="block font-mono text-[0.56rem] text-ink-600">
                                                            {c.type}
                                                        </span>
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {page.rows.map((row, i) => (
                                                <tr key={i} className="border-b border-shell-800 hover:bg-shell-800/50">
                                                    {page.columns.map((c) => {
                                                        const { text, muted } = cell(row[c.name]);
                                                        return (
                                                            <td key={c.name}
                                                                className={`whitespace-nowrap px-3 py-1 font-mono ${muted ? 'text-ink-600 italic' : 'text-ink-300'}`}>
                                                                {text}
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                {page.total > page.limit && (
                                    <div className="flex items-center gap-3 rule-t px-4 py-2">
                                        <button
                                            disabled={page.offset === 0 || loading}
                                            onClick={() => goto(Math.max(page.offset - page.limit, 0))}
                                            className="sign border border-shell-600 px-2.5 py-1 text-[0.6rem] text-ink-300 transition-colors enabled:hover:border-brand-500 enabled:hover:text-brand-300 disabled:opacity-30"
                                        >
                                            ← Prev
                                        </button>
                                        <button
                                            disabled={page.offset + page.limit >= page.total || loading}
                                            onClick={() => goto(page.offset + page.limit)}
                                            className="sign border border-shell-600 px-2.5 py-1 text-[0.6rem] text-ink-300 transition-colors enabled:hover:border-brand-500 enabled:hover:text-brand-300 disabled:opacity-30"
                                        >
                                            Next →
                                        </button>
                                        {loading && (
                                            <span className="font-mono text-[0.64rem] text-ink-600">
                                                loading<span className="animate-blink">_</span>
                                            </span>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </Panel>
                </div>

                <PageNote>
                    Every row is synthetic, generated from a fixed seed — no real plant data was
                    used or available. The structure, vocabulary, and failure modes are real; the
                    numbers are invented. Read-only: this endpoint can only SELECT, and only from
                    the relations listed here.
                </PageNote>
            </Page>
        </div>
    );
}
