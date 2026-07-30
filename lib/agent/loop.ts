/**
 * The agentic tool-use loop.
 *
 * Written explicitly rather than using the SDK's beta tool runner. The runner
 * would drive the same cycle in less code, but this loop has to interleave two
 * different kinds of output into ONE ordered stream — assistant text deltas and
 * tool lifecycle events — so the browser can render a tool chip at the exact
 * point in the transcript where the call happened. Owning the loop makes that
 * ordering explicit, and keeps a hard iteration cap in plain sight, which
 * matters for a demo with a public URL and a billing account behind it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './system-prompt';
import { TOOLS, TOOLS_BY_NAME, runTool, toolInputSchema } from '../tools/index';
import type { SourceSystem } from '../tools/types';

export const MODEL = 'claude-sonnet-5';

/** Ceiling on assistant turns per question. Each turn is a billable request. */
export const MAX_TURNS = 8;

/**
 * Caps thinking plus response text together. Generous because this is a
 * streaming request, where a large ceiling costs nothing unless it is used.
 */
export const MAX_TOKENS = 32_000;

export type AgentEvent =
    | { t: 'text'; v: string }
    | { t: 'tool_start'; id: string; name: string; sources: SourceSystem[]; input: unknown }
    | { t: 'tool_end'; id: string; name: string; ok: boolean; ms: number; summary: string }
    | { t: 'done'; turns: number; usage: UsageTotals; remaining?: number; limit?: number }
    | { t: 'error'; message: string };

export interface UsageTotals {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
}

/** A one-line description of what a tool returned, for the collapsed chip. */
function summarize(result: { data: unknown; error?: string; notes?: string[] }): string {
    if (result.error) return result.error;
    const d = result.data;
    if (d === null || d === undefined) return 'no result';
    if (Array.isArray(d)) return `${d.length} rows`;
    if (typeof d === 'object') {
        // Prefer the first array field's length — that is almost always the
        // interesting quantity (jobs, groups, heats, items).
        for (const [key, value] of Object.entries(d as Record<string, unknown>)) {
            if (Array.isArray(value)) return `${value.length} ${key.replace(/_/g, ' ')}`;
        }
        return 'ok';
    }
    return String(d);
}

export interface RunAgentOptions {
    messages: Anthropic.MessageParam[];
    emit: (event: AgentEvent) => void;
    signal?: AbortSignal;
}

export async function runAgent({ messages, emit, signal }: RunAgentOptions): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        emit({ t: 'error', message: 'ANTHROPIC_API_KEY is not configured on the server.' });
        return;
    }

    const client = new Anthropic({ apiKey });

    const toolDefs: Anthropic.Tool[] = TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toolInputSchema(t) as Anthropic.Tool.InputSchema,
    }));

    const usage: UsageTotals = {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };

    const history: Anthropic.MessageParam[] = [...messages];
    let turns = 0;

    try {
        while (turns < MAX_TURNS) {
            turns++;
            if (signal?.aborted) return;

            const stream = client.messages.stream(
                {
                    model: MODEL,
                    max_tokens: MAX_TOKENS,
                    // Adaptive thinking is ON by default on Sonnet 5 and is left
                    // that way deliberately: with thinking disabled this model
                    // reaches for tools noticeably less, which is the opposite
                    // of what a tool-driven copilot needs.
                    output_config: { effort: 'high' },
                    // cache_control on the LAST system block caches the tool
                    // definitions and the system prompt together, since tools
                    // render ahead of system in the prompt.
                    system: [
                        {
                            type: 'text',
                            text: SYSTEM_PROMPT,
                            cache_control: { type: 'ephemeral' },
                        },
                    ],
                    tools: toolDefs,
                    messages: history,
                },
                { signal },
            );

            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    emit({ t: 'text', v: event.delta.text });
                }
            }

            const message = await stream.finalMessage();

            usage.input_tokens += message.usage.input_tokens ?? 0;
            usage.output_tokens += message.usage.output_tokens ?? 0;
            usage.cache_creation_input_tokens += message.usage.cache_creation_input_tokens ?? 0;
            usage.cache_read_input_tokens += message.usage.cache_read_input_tokens ?? 0;

            // Check stop_reason BEFORE reading content. Sonnet 5 can decline a
            // request and return stop_reason "refusal", in which case content
            // may be empty and indexing into it would throw.
            if (message.stop_reason === 'refusal') {
                emit({
                    t: 'error',
                    message:
                        'The model declined to answer that request. Try rephrasing it as a ' +
                        'question about plant data.',
                });
                return;
            }

            history.push({ role: 'assistant', content: message.content });

            if (message.stop_reason !== 'tool_use') {
                emit({ t: 'done', turns, usage });
                return;
            }

            const toolUses = message.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );

            // Execute in parallel — the tools are read-only and independent, and
            // the model often asks for several at once.
            const results = await Promise.all(
                toolUses.map(async (call) => {
                    const def = TOOLS_BY_NAME.get(call.name);
                    emit({
                        t: 'tool_start',
                        id: call.id,
                        name: call.name,
                        sources: def?.sources ?? [],
                        input: call.input,
                    });

                    const started = Date.now();
                    const result = await runTool(call.name, call.input);
                    const ms = Date.now() - started;

                    emit({
                        t: 'tool_end',
                        id: call.id,
                        name: call.name,
                        ok: !result.error,
                        ms,
                        summary: summarize(result),
                    });

                    // Notes ride along with the data so the model sees caveats
                    // (truncation, reconciliation gaps) and can pass them on.
                    const payload = result.error
                        ? { error: result.error }
                        : { sources: result.sources, data: result.data, notes: result.notes };

                    return {
                        type: 'tool_result' as const,
                        tool_use_id: call.id,
                        content: JSON.stringify(payload),
                        ...(result.error ? { is_error: true } : {}),
                    };
                }),
            );

            // All results go back in a SINGLE user message. Splitting them
            // across messages trains the model out of parallel tool calls.
            history.push({ role: 'user', content: results });
        }

        emit({
            t: 'error',
            message:
                `Stopped after ${MAX_TURNS} tool-use turns without reaching an answer. ` +
                `Try a narrower question.`,
        });
    } catch (err) {
        if (signal?.aborted) return;
        const message = err instanceof Anthropic.APIError
            ? `Claude API error ${err.status}: ${err.message}`
            : err instanceof Error ? err.message : String(err);
        emit({ t: 'error', message });
    }
}
