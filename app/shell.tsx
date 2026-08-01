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
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BUILD_SHA, BUILD_TIME } from '@/lib/build';

/**
 * The one container. Every structural element on every route sits in this:
 * the header row, the page body, and the chat composer.
 *
 * Not exported, and that is the point. Pages used to reach for their own
 * `max-w-[…]` and their own padding, which is how the chat ended up in a 768px
 * column with 48px of top padding while every other page ran full width with
 * 24px. A page cannot set its frame if it cannot name it — it renders
 * `<AppFrame>` and inherits this.
 *
 * The numbers live in globals.css as tokens, so changing the width or the
 * gutter is one edit that lands on all five routes at once.
 */
const SHELL = 'mx-auto w-full max-w-[var(--layout-max)] px-4 sm:px-6 lg:px-8';

/**
 * A typographic measure for prose, sitting INSIDE the shared container — a cap
 * on line length, not a page frame. Deliberately has no `mx-auto` and no
 * `w-full`: it cannot centre a column or narrow the frame, only stop a
 * paragraph running to 1400px. Tables, grids, and panels never use it.
 */
export const PROSE = 'max-w-[68ch]';

/**
 * Fixed order, every destination on every page. The current page stays in the
 * list and is marked, rather than being dropped — a nav whose items move around
 * as you browse is the thing that makes an app feel unconsidered.
 *
 * This is also the ONLY place a page is named. The header title is looked up
 * from here by pathname rather than passed in, because when pages named
 * themselves they drifted: the chat called itself "Foundry Ops Copilot" while
 * its nav item said "Ask", and the schedule called itself "Week Schedule" while
 * its nav item said "Schedule". One list, one name, no way to disagree.
 */
const NAV = [
    { href: '/', label: 'Copilot' },
    { href: '/dashboard', label: 'Plant status' },
    { href: '/schedule', label: 'Schedule' },
    { href: '/data', label: 'Source data' },
    { href: '/tools', label: 'Tools' },
] as const;

/**
 * The header. One row, one fixed height, on every route.
 *
 * Not exported: it is reachable only through `AppFrame`, so no page can render
 * it with different content, and there is no slot to hang a second row from.
 * That slot is exactly what broke this — the chat put its source bus inside the
 * header, which pushed the red rule (the header's bottom border) 59px lower on
 * `/` than on the other four routes. Header-adjacent content that is specific
 * to one page now goes in that page's body, below the rule.
 *
 * The row is `--layout-header-h` tall and nothing inside it can grow: every
 * child is `shrink-0`, and below `md` the nav collapses into a menu rather than
 * wrapping onto a second line. So the rule lands on the same Y at every width,
 * on every page — the open menu is positioned out of flow for the same reason.
 */
function AppHeader({
    meta,
    page: pageOverride,
}: {
    /** Small monospace note beside the title — dataset date, week, row count. */
    meta?: string;
    /**
     * Names a page that is not a destination — in practice only the 404, which
     * matches no NAV entry and would otherwise render a bare product name.
     * Real pages must NOT pass this: taking their name from NAV is what stops a
     * header and its nav item drifting apart, which they previously had.
     */
    page?: string;
}) {
    const pathname = usePathname();
    const page = pageOverride ?? NAV.find((item) => item.href === pathname)?.label;
    const [menuOpen, setMenuOpen] = useState(false);

    // Arriving somewhere new must not leave the menu standing open over it.
    // Adjusted during render rather than in an effect: an effect would paint
    // the new page with the old menu on top of it first, and setting state in
    // an effect body is what react-hooks/set-state-in-effect exists to stop.
    // Tracking the path in state also catches back/forward, which a click
    // handler on the links would miss.
    const [menuPath, setMenuPath] = useState(pathname);
    if (menuPath !== pathname) {
        setMenuPath(pathname);
        setMenuOpen(false);
    }

    // Escape closes it, because a panel that covers the page needs a way out
    // that is not "find the button again".
    useEffect(() => {
        if (!menuOpen) return;
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [menuOpen]);

    return (
        // z-50 is load-bearing: `backdrop-blur` makes the header its own
        // stacking context, so without it the menu's own z-index is trapped
        // inside a layer that the page's animated cards paint straight over.
        <header className="relative z-50 rule-brand bg-shell-900/80 backdrop-blur">
            <div
                className={`${SHELL} flex h-[var(--layout-header-h)] items-center gap-3`}
            >
                {/* Title group. Baseline-aligned within itself, centred as a
                    group in the fixed row — the internal alignment survives,
                    the row height does not depend on it. */}
                <div className="flex min-w-0 items-baseline gap-3">
                    <span className="h-2 w-2 shrink-0 self-center rounded-full bg-brand-500" />
                    {/* The product name stays constant and quiet; the page name
                        is the bright part. Same two-part title on every surface,
                        so where you are is always read in the same place.

                        This is the one thing in the row allowed to give: below
                        about 430px the longest page names ("Plant status",
                        "Source data") would otherwise push the menu button off
                        the right edge. The title truncates instead, because it
                        is the only element here that is repeated elsewhere —
                        the current page is named again, in full, in the open
                        menu. The badge and the button never shrink. */}
                    <h1 className="sign flex min-w-0 items-baseline gap-1.5 text-[0.92rem]">
                        <span className="shrink-0 text-ink-500">Foundry Ops</span>
                        {page && (
                            <>
                                <span className="shrink-0 text-ink-600">·</span>
                                <span className="truncate text-ink-100">{page}</span>
                            </>
                        )}
                    </h1>
                    {/* Says what this is before anyone has to look for it. Lives
                        in the shared header on purpose: the empty state is easy
                        to miss and easy to skip past, and a visitor arriving on
                        the dashboard or the schedule never sees it at all.
                        Deliberately ink-500 rather than ink-600 — this carries a
                        label, and the token comments in globals.css reserve
                        ink-600 for decoration.

                        The commit used to be printed here. It is a build
                        artefact and it means nothing to a visitor, so it now
                        lives in this tooltip and in the `build` meta tag — still
                        one glance from anyone checking whether they are looking
                        at a stale cache, and invisible to everyone else. */}
                    <span
                        title={
                            'A portfolio demo. The plant, the jobs, and every number are generated.\n' +
                            `Build ${BUILD_SHA}, ${BUILD_TIME} UTC.`
                        }
                        className="sign shrink-0 border border-shell-600 px-1.5 py-0.5 text-[0.58rem] leading-none text-ink-500"
                    >
                        Demo · synthetic data
                    </span>
                    {meta && (
                        <span className="hidden truncate font-mono text-[0.68rem] text-ink-600 sm:inline">
                            {meta}
                        </span>
                    )}
                </div>
                {/* Five destinations do not fit beside the title on a phone —
                    they were running off the right edge — so below `md` they
                    collapse into the menu instead. Above it, the full list,
                    which is worth more than a button on a screen with room for
                    it. Never wraps at any width: a second nav line would move
                    the red rule down, which is the old bug in another costume.
                    `ml-auto` right-aligns it; there is deliberately no
                    `justify-end`, which strands the first items off the left
                    edge where nothing can scroll back to them. */}
                <nav className="scroll-hidden ml-auto hidden min-w-0 flex-nowrap items-center gap-x-4 overflow-x-auto whitespace-nowrap md:flex">
                    {NAV.map((item) => {
                        const active = pathname === item.href;
                        return active ? (
                            <span
                                key={item.href}
                                aria-current="page"
                                className="sign shrink-0 text-[0.64rem] text-brand-300"
                            >
                                {item.label}
                            </span>
                        ) : (
                            <Link
                                key={item.href}
                                href={item.href}
                                className="sign shrink-0 text-[0.64rem] text-ink-500 transition-colors hover:text-brand-300"
                            >
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>

                <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-expanded={menuOpen}
                    aria-controls="app-menu"
                    aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                    className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center border border-shell-600 text-ink-300 transition-colors hover:border-brand-500 hover:text-brand-300 md:hidden"
                >
                    <svg
                        aria-hidden
                        viewBox="0 0 16 16"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.25"
                        strokeLinecap="square"
                    >
                        {menuOpen ? (
                            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
                        ) : (
                            <path d="M2 4.5h12M2 8h12M2 11.5h12" />
                        )}
                    </svg>
                </button>
            </div>

            {/* Out of flow on purpose: an open menu must not push the red rule
                down, which is the whole invariant this header exists to hold.
                It hangs below the rule instead, at the same gutter as the page
                under it. */}
            {menuOpen && (
                <div
                    id="app-menu"
                    className="absolute inset-x-0 top-full z-40 rule-b bg-shell-900 shadow-lg shadow-black/40 md:hidden"
                >
                    <nav className={`${SHELL} flex flex-col py-1`}>
                        {NAV.map((item) => {
                            const active = pathname === item.href;
                            return active ? (
                                <span
                                    key={item.href}
                                    aria-current="page"
                                    className="sign border-l-2 border-brand-500 py-2.5 pl-3 text-[0.7rem] text-brand-300"
                                >
                                    {item.label}
                                </span>
                            ) : (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className="sign border-l-2 border-transparent py-2.5 pl-3 text-[0.7rem] text-ink-300 transition-colors hover:border-shell-600 hover:text-brand-300"
                                >
                                    {item.label}
                                </Link>
                            );
                        })}
                        {/* The one place the dataset note is readable on a
                            phone, where it is hidden from the header row. */}
                        {meta && (
                            <span className="rule-t mt-1 py-2 pl-3 font-mono text-[0.66rem] text-ink-600">
                                {meta}
                            </span>
                        )}
                    </nav>
                </div>
            )}
        </header>
    );
}

/**
 * The frame. Every route renders exactly this and nothing outside it.
 *
 * Header, container, and vertical rhythm all arrive from here, so a page has no
 * opportunity to disagree about any of them: it supplies content, and at most a
 * `meta` string and a sticky footer. Before this, five pages each assembled
 * their own `<div>` + `<AppHeader>` + `<main>`, and the chat assembled a
 * different one — which is precisely how the header height, the rule position,
 * the body width, and the top padding came to differ per route.
 */
export function AppFrame({
    meta,
    page,
    footer,
    children,
}: {
    /** Small monospace note beside the title — dataset date, week, row count. */
    meta?: string;
    /** Only for surfaces that are not in NAV; in practice, the 404. */
    page?: string;
    /**
     * Pinned to the bottom of the viewport, inside the shared container — the
     * chat composer, and nothing else so far.
     */
    footer?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-h-full flex-1 flex-col">
            <AppHeader meta={meta} page={page} />

            <main className={`${SHELL} flex-1 py-[var(--layout-pad-y)]`}>{children}</main>

            {footer && (
                <div className="sticky bottom-0 rule-t bg-shell-900/90 backdrop-blur">
                    <div className={`${SHELL} py-3`}>{footer}</div>
                </div>
            )}
        </div>
    );
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
