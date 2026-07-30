/**
 * Ask the copilot a question from the terminal.
 *
 *   npm run ask -- "which open jobs are at risk and why?"
 *
 * Exercises the exact same agent loop the web chat uses, without the browser in
 * the way. Useful for checking a question before putting it on the demo page,
 * and for reading the tool-call sequence and token usage directly.
 */
import { config as loadEnv } from 'dotenv';
import { runAgent, MODEL, type AgentEvent } from '../lib/agent/loop';
import { SYSTEM_PROMPT } from '../lib/agent/system-prompt';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });

const DEFAULT_QUESTION =
    'Scrap is up on the 4471 bracket. What is causing it, and is the customer expedite at risk?';

// Rough only — for an exact count use the count_tokens endpoint.
const approxTokens = (s: string) => Math.round(s.length / 3.7);

async function main() {
    const question = process.argv.slice(2).join(' ').trim() || DEFAULT_QUESTION;

    console.log(`model:  ${MODEL}`);
    console.log(`system: ~${approxTokens(SYSTEM_PROMPT)} tokens ` +
                `(needs >1024 to cache on Sonnet 5)\n`);
    console.log(`Q: ${question}`);
    console.log('='.repeat(72));

    const startedAt = Date.now();
    let sawError = false;

    await runAgent({
        messages: [{ role: 'user', content: question }],
        emit: (e: AgentEvent) => {
            switch (e.t) {
                case 'text':
                    process.stdout.write(e.v);
                    break;
                case 'tool_start':
                    console.log(`\n  -> ${e.name}  [${e.sources.join(' + ')}]  ${JSON.stringify(e.input)}`);
                    break;
                case 'tool_end':
                    console.log(`  <- ${e.name}  ${e.ok ? 'ok' : 'FAILED'}  ${e.summary}  (${e.ms}ms)`);
                    break;
                case 'done': {
                    const wall = ((Date.now() - startedAt) / 1000).toFixed(1);
                    const u = e.usage;
                    console.log(`\n\n${'='.repeat(72)}`);
                    console.log(`turns ${e.turns}   wall ${wall}s`);
                    console.log(
                        `tokens  in ${u.input_tokens}   out ${u.output_tokens}   ` +
                        `cache write ${u.cache_creation_input_tokens}   ` +
                        `cache read ${u.cache_read_input_tokens}`,
                    );
                    if (u.cache_read_input_tokens === 0) {
                        console.log(
                            '\nNOTE: zero cache reads. Expected on the first call of a session; ' +
                            'if it persists, something is invalidating the prompt prefix.',
                        );
                    }
                    break;
                }
                case 'error':
                    sawError = true;
                    console.log(`\n\nERROR: ${e.message}`);
                    break;
            }
        },
    });

    if (sawError) process.exit(1);
}

main().catch((err) => {
    console.error('\nask failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
