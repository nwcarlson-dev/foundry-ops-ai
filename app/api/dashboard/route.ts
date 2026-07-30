/**
 * Dashboard data.
 *
 * Detection is entirely deterministic (lib/anomalies.ts). The model is asked for
 * exactly one thing: a sentence of narrative per finding, over numbers it did
 * not produce and cannot change.
 *
 * Narratives are cached against a fingerprint of the findings. The dataset is
 * fixed and seeded, so the fingerprint is stable and a warm process serves the
 * dashboard without touching the API at all — which matters when the URL is
 * public and the billing account is mine.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDashboard, type Finding } from '@/lib/anomalies';
import { MODEL } from '@/lib/agent/loop';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

let cache: { key: string; narratives: Record<string, string> } | null = null;

const fingerprint = (findings: Finding[]) =>
    findings.map((f) => `${f.id}:${f.detail}`).join('|');

async function narrate(findings: Finding[]): Promise<Record<string, string>> {
    if (findings.length === 0) return {};

    const key = fingerprint(findings);
    if (cache?.key === key) return cache.narratives;
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
        cache = { key, narratives };
        return narratives;
    } catch {
        return {};   // a dashboard without narrative is still a working dashboard
    }
}

export async function GET(request: Request) {
    try {
        const dashboard = await getDashboard();

        // ?narrate=0 renders the deterministic dashboard with no API call.
        const wantNarrative = new URL(request.url).searchParams.get('narrate') !== '0';
        if (wantNarrative) {
            const narratives = await narrate(dashboard.findings);
            for (const f of dashboard.findings) {
                f.narrative = narratives[f.id];
            }
        }

        return Response.json(dashboard, {
            headers: { 'Cache-Control': 'no-store' },
        });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : 'Dashboard query failed.' },
            { status: 500 },
        );
    }
}
