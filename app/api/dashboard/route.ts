/**
 * Dashboard data.
 *
 * Detection is entirely deterministic (lib/anomalies.ts). This route serves that
 * and nothing else: it attaches the model's one-line notes if they are already
 * cached, but it will never wait for them to be written.
 *
 * That distinction is the whole point. This route used to await generation
 * before responding, behind a module-level cache that is always empty on
 * serverless — so a visitor waited ~9s on a loading state for prose describing
 * numbers this route had finished computing in 0.4s. Generation now lives at
 * ./narrative, which the page requests only after it has already painted.
 */
import { getDashboard } from '@/lib/anomalies';
import { readDashboardNarratives } from '@/lib/narrative/dashboard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
    try {
        const dashboard = await getDashboard();

        // ?narrate=0 renders the deterministic dashboard with no cache lookup.
        const wantNarrative = new URL(request.url).searchParams.get('narrate') !== '0';
        const narratives = wantNarrative
            ? await readDashboardNarratives(dashboard.findings)
            : {};

        for (const f of dashboard.findings) {
            f.narrative = narratives?.[f.id];
        }

        return Response.json(
            {
                ...dashboard,
                // Whether the page should go and ask for prose now that it has
                // its numbers. Missing narratives are normal, not an error.
                narrative_pending: wantNarrative && narratives === null,
            },
            { headers: { 'Cache-Control': 'no-store' } },
        );
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : 'Dashboard query failed.' },
            { status: 500 },
        );
    }
}
