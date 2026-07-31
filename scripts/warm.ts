/**
 * Pre-generate every piece of model-written prose the site shows.
 *
 *   npm run warm
 *
 * The dashboard's notes and the schedule's explanation are cached in Postgres
 * against a fingerprint of the facts they describe. Run this once and no
 * visitor ever waits for generation — including the first, which is the case a
 * warm-on-demand cache can never cover.
 *
 * Local and production share a database, so warming from a laptop warms the
 * deployment. Run it after any change to the dataset or to a narrative prompt;
 * both change the fingerprint, which is the point.
 *
 * Costs a handful of low-effort calls. Everything here is idempotent — a second
 * run finds every key already cached and calls nothing.
 */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });

import { getDashboard } from '../lib/anomalies';
import { buildSchedule } from '../lib/scheduler';
import { ensureDashboardNarratives, readDashboardNarratives } from '../lib/narrative/dashboard';
import { ensureScheduleSummary, readScheduleSummary } from '../lib/narrative/schedule';

const DEPTS = ['MELT', 'MOLD', 'CORE', 'CLEAN', 'HEAT_TREAT', 'MACHINE'];

async function main() {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('ANTHROPIC_API_KEY is not set — nothing can be generated.');
        process.exit(1);
    }

    let generated = 0;

    process.stdout.write('dashboard  ');
    const { findings } = await getDashboard();
    const hadDashboard = await readDashboardNarratives(findings);
    const narratives = await ensureDashboardNarratives(findings);
    if (!hadDashboard) generated++;
    console.log(
        `${hadDashboard ? 'cached' : 'generated'} — ${Object.keys(narratives).length} notes ` +
        `over ${findings.length} findings`,
    );

    // Every filter the page offers, because each one is its own cache key — the
    // old single-slot cache was evicted on every click between them.
    for (const dept of [undefined, ...DEPTS]) {
        const label = dept ?? 'all';
        process.stdout.write(`schedule ${label.padEnd(11)}`);
        const schedule = await buildSchedule({ dept });
        const had = await readScheduleSummary(schedule);
        const summary = await ensureScheduleSummary(schedule);
        if (!had) generated++;
        console.log(
            summary
                ? `${had ? 'cached' : 'generated'} — ${summary.length} chars`
                : 'no summary returned',
        );
    }

    console.log(`\n${generated} generated, ${8 - generated} already cached.`);
}

main().catch((err) => {
    console.error('\nwarm failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
