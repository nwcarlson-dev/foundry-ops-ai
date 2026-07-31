'use client';

/**
 * 404.
 *
 * Without this file Next serves its own black-on-white default, which against a
 * dark industrial theme reads as a page that fell out of a different website —
 * and a reviewer poking at URLs is exactly who finds it.
 *
 * Keeps the full chrome rather than showing a bare message, because the useful
 * thing to hand someone who is lost is the way back.
 */
import Link from 'next/link';

import { AppHeader, Page, MEASURE } from './shell';

const DESTINATIONS = [
    { href: '/', label: 'Copilot', note: 'ask across all four systems' },
    { href: '/dashboard', label: 'Plant status', note: 'what changed, and what it means' },
    { href: '/schedule', label: 'Schedule', note: 'this week against real capacity' },
    { href: '/data', label: 'Source data', note: 'every table behind the answers' },
    { href: '/tools', label: 'Tools', note: 'the tool layer, over MCP' },
];

export default function NotFound() {
    return (
        <div className="flex min-h-full flex-1 flex-col">
            <AppHeader page="Not found" meta="404" />

            <Page>
                <div className={MEASURE}>
                    <p className="font-display text-[3rem] leading-none text-shell-500 tabular-nums">
                        404
                    </p>
                    <p className="mt-3 max-w-[68ch] text-[0.95rem] leading-relaxed text-ink-300">
                        <span className="text-ink-100">No such page.</span>{' '}
                        Nothing is broken — that address just does not exist here. Everything
                        this demo can do is below.
                    </p>

                    <div className="mt-7 space-y-px">
                        {DESTINATIONS.map((d) => (
                            <Link
                                key={d.href}
                                href={d.href}
                                className="group flex w-full items-center gap-3 border-l-2 border-shell-600 bg-shell-850/50 px-3.5 py-2.5 text-left transition-all hover:border-brand-500 hover:bg-shell-800"
                            >
                                <span className="sign flex-1 text-[0.7rem] text-ink-300 transition-colors group-hover:text-ink-100">
                                    {d.label}
                                </span>
                                <span className="shrink-0 font-mono text-[0.64rem] text-ink-500">
                                    {d.note}
                                </span>
                            </Link>
                        ))}
                    </div>
                </div>
            </Page>
        </div>
    );
}
