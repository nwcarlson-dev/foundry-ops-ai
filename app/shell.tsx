'use client';

/**
 * The layout system every surface is built from.
 *
 * Before this existed, each page invented its own container width, panel tint,
 * error box, and nav — four pages, four sets of margins, and a nav whose items
 * changed depending on where you were standing. Everything shared lives here
 * now, so a change to the chrome happens once and lands everywhere.
 *
 * The rule: pages own their content, never their frame.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The page gutter. Fluid width, responsive margins — the container tracks the
 * viewport instead of snapping to a fixed column, and the gutter steps up with
 * available space the way a normal layout does.
 *
 * Width is deliberately unbounded: a data table wants every pixel a wide screen
 * offers. What must not run wide is *prose*, and that is solved where it belongs
 * — `.answer` and the page intros cap at 68ch in globals.css, a typographic
 * measure rather than a layout one.
 *
 * Every header, body, and composer uses this one constant, so the left and right
 * gutters line up across all four pages at every breakpoint.
 */
export const SHELL = 'mx-auto w-full px-4 sm:px-6 lg:px-8';

/**
 * The reading column, for content that is read rather than scanned — the
 * conversation and the page intros. Dense surfaces (tables, the schedule grid,
 * the dashboard) deliberately do not use this: they want the full viewport.
 *
 * This is a typographic measure sitting *inside* the shared gutter, not a second
 * layout system. The gutters still line up across every page.
 */
export const MEASURE = 'mx-auto w-full max-w-[80ch]';

/**
 * Fixed order, every destination on every page. The current page stays in the
 * list and is marked, rather than being dropped — a nav whose items move around
 * as you browse is the thing that makes an app feel unconsidered.
 */
const NAV = [
    { href: '/', label: 'Ask' },
    { href: '/dashboard', label: 'Plant status' },
    { href: '/schedule', label: 'Schedule' },
    { href: '/data', label: 'Source data' },
] as const;

export function AppHeader({
    title,
    meta,
    children,
}: {
    title: string;
    /** Small monospace note beside the title — dataset date, week, row count. */
    meta?: string;
    /** Optional second row inside the header (the chat's source bus). */
    children?: React.ReactNode;
}) {
    const pathname = usePathname();

    return (
        <header className="rule-brand bg-shell-900/80 backdrop-blur">
            <div className={`${SHELL} flex items-baseline gap-3 py-3`}>
                <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" />
                <h1 className="sign shrink-0 text-[0.92rem] text-ink-100">{title}</h1>
                {meta && (
                    <span className="hidden truncate font-mono text-[0.68rem] text-ink-600 sm:inline">
                        {meta}
                    </span>
                )}
                <nav className="ml-auto flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1">
                    {NAV.map((item) => {
                        const active = pathname === item.href;
                        return active ? (
                            <span
                                key={item.href}
                                aria-current="page"
                                className="sign text-[0.64rem] text-brand-300"
                            >
                                {item.label}
                            </span>
                        ) : (
                            <Link
                                key={item.href}
                                href={item.href}
                                className="sign text-[0.64rem] text-ink-500 transition-colors hover:text-brand-300"
                            >
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>
            </div>
            {children && <div className={`${SHELL} pb-3`}>{children}</div>}
        </header>
    );
}

/** The standard content column. Every page's <main> is this. */
export function Page({ children }: { children: React.ReactNode }) {
    return <main className={`${SHELL} flex-1 py-6`}>{children}</main>;
}

/**
 * A bordered section with a titled header strip. One tint, one border, one
 * padding — previously this shape existed at three different opacities.
 */
export function Panel({
    title,
    meta,
    children,
    flush = false,
    tone = 'normal',
}: {
    /**
     * A string gets the standard stencilled-sign treatment. Pass a node when the
     * heading is data rather than a label — a relation name is monospace and
     * lowercase, and uppercasing it would misrepresent it.
     */
    title: React.ReactNode;
    meta?: string;
    children: React.ReactNode;
    /** Skip the body padding, for content that manages its own (tables, grids). */
    flush?: boolean;
    /** `danger` tints only the title — the panel itself never turns red. */
    tone?: 'normal' | 'danger';
}) {
    return (
        <section className="min-w-0 border border-shell-700 bg-shell-850/60">
            <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rule-b px-4 py-2">
                {typeof title === 'string' ? (
                    <h2
                        className="sign text-[0.68rem]"
                        style={{
                            color:
                                tone === 'danger'
                                    ? 'var(--color-danger)'
                                    : 'var(--color-ink-300)',
                        }}
                    >
                        {title}
                    </h2>
                ) : (
                    <h2 className="min-w-0">{title}</h2>
                )}
                {meta && <span className="font-mono text-[0.64rem] text-ink-600">{meta}</span>}
            </header>
            <div className={flush ? '' : 'p-4'}>{children}</div>
        </section>
    );
}

/** Failure, stated plainly and identically everywhere. */
export function ErrorBox({ children }: { children: React.ReactNode }) {
    return (
        <div
            className="border-l-2 px-3 py-2 text-[0.85rem]"
            style={{
                borderColor: 'var(--color-danger)',
                background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
                color: '#f0a3a5',
            }}
        >
            {children}
        </div>
    );
}

/** A row of headline numbers. Hairline-separated, never boxed individually. */
export function StatTiles({
    items,
}: {
    items: { label: string; value: string | number }[];
}) {
    return (
        // auto-fit rather than a fixed column count: the row reflows on its own
        // as the viewport narrows — four tiles become two on a phone — without
        // needing a breakpoint per possible tile count.
        <div
            className="grid gap-px bg-shell-700"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))' }}
        >
            {items.map((s) => (
                <div key={s.label} className="bg-shell-850 px-4 py-3">
                    <div className="font-display text-[1.6rem] leading-none text-ink-100 tabular-nums">
                        {s.value}
                    </div>
                    <div className="sign mt-1 text-[0.6rem] text-ink-600">{s.label}</div>
                </div>
            ))}
        </div>
    );
}

/** The quiet closing note each page ends on. */
export function PageNote({ children }: { children: React.ReactNode }) {
    return (
        <p className="mt-5 font-mono text-[0.64rem] leading-relaxed text-ink-600">{children}</p>
    );
}

/** Shared loading state, so "loading…" reads the same on every surface. */
export function Loading({ verb }: { verb: string }) {
    return (
        <div className="py-16 text-center font-mono text-[0.74rem] text-ink-600">
            {verb}
            <span className="animate-blink">_</span>
        </div>
    );
}
