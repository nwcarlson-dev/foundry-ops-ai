/**
 * The dashboard's one-line notes, generated on demand.
 *
 * Split out from the dashboard route so a page load never waits on a model
 * call. The page fetches this after it has painted its numbers, and only when
 * the cache missed — which after `npm run warm` should be never.
 *
 * The findings are recomputed here rather than accepted from the request body.
 * That costs a few hundred ms of SQL on a path that should almost never run,
 * and buys two things: the prompt can only ever contain facts this server
 * derived, and the cache key cannot be forged into a write.
 */
import { getDashboard } from '@/lib/anomalies';
import { ensureDashboardNarratives } from '@/lib/narrative/dashboard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
    try {
        const { findings } = await getDashboard();
        const narratives = await ensureDashboardNarratives(findings);
        return Response.json(
            { narratives },
            { headers: { 'Cache-Control': 'no-store' } },
        );
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : 'Narrative generation failed.' },
            { status: 500 },
        );
    }
}
