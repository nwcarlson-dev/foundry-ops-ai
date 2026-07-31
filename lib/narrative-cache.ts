/**
 * Persistent storage for model-written prose.
 *
 * Both the dashboard and the schedule ask the model for a sentence or two over
 * numbers that deterministic code already produced. That generation used to be
 * memoised in a module-level variable, which works on a laptop and does nothing
 * at all on Vercel: every request arrives at a fresh isolated function, so the
 * cache was empty for effectively every visitor and each one waited ~9 seconds
 * staring at a loading state while the model described data that had been ready
 * in 0.4s.
 *
 * The key is a fingerprint of the facts being described. Both datasets are
 * deterministic over a fixed seed, so a fingerprint always refers to the same
 * numbers and its prose never goes stale — which makes this a permanent cache
 * rather than one with an expiry to reason about.
 *
 * Every function here fails soft. Prose is decoration over numbers the page
 * already has; a cache outage must cost the sentence, never the dashboard.
 */
import { query, queryOne } from './db';

export async function readNarrative<T>(key: string): Promise<T | null> {
    try {
        const row = await queryOne<{ payload: T }>(
            `SELECT payload FROM app.narrative_cache WHERE key = $1`,
            [key],
        );
        return row?.payload ?? null;
    } catch {
        return null;
    }
}

export async function writeNarrative(key: string, payload: unknown): Promise<void> {
    try {
        await query(
            `INSERT INTO app.narrative_cache (key, payload)
             VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET payload = $2::jsonb, created_at = now()`,
            [key, JSON.stringify(payload)],
        );
    } catch {
        // Losing the write costs the next visitor a regeneration, nothing more.
    }
}
