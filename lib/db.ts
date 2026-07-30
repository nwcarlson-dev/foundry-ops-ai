/**
 * Application-side database access.
 *
 * Uses the Neon HTTP driver rather than the WebSocket client the seed script
 * uses: these run inside Vercel serverless functions where a per-request HTTP
 * round trip is cheaper than establishing a socket.
 *
 * Everything here is READ-ONLY by construction. The model never supplies SQL —
 * it selects a tool and supplies typed parameters, and every value reaches the
 * database as a bind parameter. See lib/tools/README for the reasoning.
 */
import { neon } from '@neondatabase/serverless';

let cached: ReturnType<typeof neon> | null = null;

function client() {
    if (cached) return cached;
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    cached = neon(url);
    return cached;
}

/** Parameterized read. Params are always bound, never interpolated. */
export async function query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
): Promise<T[]> {
    const rows = await client().query(text, params);
    return rows as T[];
}

/** First row, or null. */
export async function queryOne<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
): Promise<T | null> {
    const rows = await query<T>(text, params);
    return rows.length > 0 ? rows[0] : null;
}
