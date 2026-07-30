/**
 * Chat endpoint.
 *
 * Streams newline-delimited JSON events (text deltas and tool lifecycle) so the
 * browser can render the transcript and the tool chips in the order they
 * actually happened.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent, type AgentEvent } from '@/lib/agent/loop';
import { reserveQuery, recordUsage, peekQuota } from '@/lib/ratelimit';

// This route is inherently dynamic and must never be cached or prerendered.
export const dynamic = 'force-dynamic';

// A multi-turn tool loop can legitimately run past the default. Vercel reads
// this from the build output to set the function's execution limit.
export const maxDuration = 120;

/** Hard ceiling on conversation length sent to the model, for cost control. */
const MAX_HISTORY_MESSAGES = 24;
const MAX_QUESTION_CHARS = 2000;

interface ChatRequestBody {
    messages?: Array<{ role: string; content: unknown }>;
}

/** Remaining questions, so the UI can warn before the visitor hits the wall. */
export async function GET(request: Request) {
    const quota = await peekQuota(request);
    return Response.json(quota, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
    let body: ChatRequestBody;
    try {
        body = (await request.json()) as ChatRequestBody;
    } catch {
        return Response.json({ error: 'Request body must be JSON.' }, { status: 400 });
    }

    const incoming = Array.isArray(body.messages) ? body.messages : [];
    if (incoming.length === 0) {
        return Response.json({ error: 'No messages supplied.' }, { status: 400 });
    }

    // Only user and assistant turns are accepted from the client, and only
    // string content. The client cannot inject tool results or system text.
    const messages: Anthropic.MessageParam[] = [];
    for (const m of incoming.slice(-MAX_HISTORY_MESSAGES)) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        if (typeof m.content !== 'string') continue;
        const content = m.content.slice(0, MAX_QUESTION_CHARS).trim();
        if (content.length === 0) continue;
        messages.push({ role: m.role, content });
    }

    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
        return Response.json(
            { error: 'The last message must be a non-empty user message.' },
            { status: 400 },
        );
    }

    // Spend guard. Reserved before any model call, so a refused request costs
    // nothing but a single INSERT.
    const quota = await reserveQuery(request);
    if (!quota.allowed) {
        return Response.json(
            { error: quota.reason, remaining: 0, limit: quota.limit },
            { status: 429 },
        );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            let closed = false;
            const emit = (event: AgentEvent) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
                } catch {
                    closed = true;   // client went away mid-stream
                }
            };

            try {
                await runAgent({
                    messages,
                    signal: request.signal,
                    emit: (event) => {
                        // Tell the client how much budget is left, and bank what
                        // the turn actually cost against the monthly ceiling.
                        if (event.t === 'done') {
                            void recordUsage(
                                event.usage.input_tokens + event.usage.cache_creation_input_tokens
                                    + event.usage.cache_read_input_tokens,
                                event.usage.output_tokens,
                            );
                            emit({ ...event, remaining: quota.remaining, limit: quota.limit });
                            return;
                        }
                        emit(event);
                    },
                });
            } catch (err) {
                emit({
                    t: 'error',
                    message: err instanceof Error ? err.message : 'Unexpected server error.',
                });
            } finally {
                closed = true;
                try { controller.close(); } catch { /* already closed */ }
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
        },
    });
}
