/**
 * The dashboard's one-line notes.
 *
 * Detection is entirely deterministic (lib/anomalies.ts). The model is asked for
 * exactly one thing: a sentence per finding, over numbers it did not produce and
 * cannot change.
 *
 * Generation lives here rather than in the route because three callers need it —
 * the narrative route, the warm script, and nothing else may generate. In
 * particular GET /api/dashboard is now forbidden from calling `generate`: that
 * blocking await was the reason the page sat on a loading state for ~9s while
 * prose was written over data that had been ready in 0.4s.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Finding } from '../anomalies';
import { MODEL } from '../agent/loop';
import { readNarrative, writeNarrative } from '../narrative-cache';

export type Narratives = Record<string, string>;

/**
 * Cache key: the findings and their facts.
 *
 * Prefixed, because the schedule's prose shares the table. Deterministic
 * detection over a fixed dataset means the same key always describes the same
 * numbers, so a hit is never stale.
 */
export const dashboardKey = (findings: Finding[]) =>
    `dashboard:${findings.map((f) => `${f.id}:${f.detail}`).join('|')}`;

/** Cache only. Never calls the model — this is what a page load is allowed to do. */
export async function readDashboardNarratives(findings: Finding[]): Promise<Narratives | null> {
    if (findings.length === 0) return {};
    return readNarrative<Narratives>(dashboardKey(findings));
}

/** Cache, or generate and persist. Only the narrative route and the warm script. */
export async function ensureDashboardNarratives(findings: Finding[]): Promise<Narratives> {
    if (findings.length === 0) return {};

    const cached = await readDashboardNarratives(findings);
    if (cached) return cached;
    if (!process.env.ANTHROPIC_API_KEY) return {};

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1200,
        // Shallow work on numbers that are already computed — no reason to pay
        // for deep reasoning here.
        output_config: { effort: 'low' },
        system:
            'You write one-line notes for a foundry supervisor\'s dashboard at an aluminium ' +
            'sand and permanent-mold plant. For each finding you are given, write ONE sentence ' +
            'saying what it most likely means and what to check next. Assume the reader knows ' +
            'castings — do not explain what a defect is. Never restate the numbers you were ' +
            'given; they are already on screen. Never invent a number, job, or heat. ' +
            'Reply as JSON: an object mapping each finding id to its sentence, nothing else.',
        messages: [{
            role: 'user',
            content: findings
                .map((f) => `id: ${f.id}\ntitle: ${f.title}\nfacts: ${f.detail}`)
                .join('\n\n'),
        }],
    });

    // Sonnet 5 can decline; check before reading content.
    if (response.stop_reason === 'refusal') return {};

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    try {
        const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/gm, '').trim());
        const narratives = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
                .map(([k, v]) => [k, String(v)]),
        );
        await writeNarrative(dashboardKey(findings), narratives);
        return narratives;
    } catch {
        return {};   // a dashboard without narrative is still a working dashboard
    }
}
