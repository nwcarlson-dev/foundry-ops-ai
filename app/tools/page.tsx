/**
 * The tool layer, made visible — and connectable.
 *
 * A server component on purpose. It needs no state and no fetching, so it reads
 * the registry directly at build time and ships essentially no client JavaScript
 * (the copy button is the one exception). That is also the honest way to render
 * this page: the list you are reading IS lib/tools/, not a description of it.
 *
 * The point it exists to make: the twelve tools behind the copilot are not
 * locked inside this app. Point your own MCP client at the deployment and you
 * have the same access the chat has.
 */
import Link from 'next/link';

import { TOOLS, toolInputSchema } from '@/lib/tools/index';
import { DATASET_TODAY } from '@/lib/dataset';
import { AppHeader, Page, Panel, PageNote, MEASURE } from '../shell';
import { SOURCE_COLOR } from '../sources';
import { CopyButton } from './copy';

const ENDPOINT = 'https://foundry-ops-ai.vercel.app/api/mcp';
const CLAUDE_CODE_CMD = `claude mcp add --transport http foundry-ops ${ENDPOINT}`;
const CLAUDE_DESKTOP_JSON = `{
  "mcpServers": {
    "foundry-ops": {
      "type": "http",
      "url": "${ENDPOINT}"
    }
  }
}`;

/** A JSON Schema property, as far as this page cares. */
interface SchemaProp {
    type?: string;
    description?: string;
    enum?: unknown[];
    default?: unknown;
}

function paramsOf(tool: (typeof TOOLS)[number]) {
    const schema = toolInputSchema(tool) as {
        properties?: Record<string, SchemaProp>;
        required?: string[];
    };
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
        name,
        type: prop.enum ? prop.enum.map(String).join(' | ') : (prop.type ?? 'any'),
        required: required.has(name),
        description: prop.description,
    }));
}

function CommandBlock({ label, code }: { label: string; code: string }) {
    return (
        <div>
            <div className="mb-1 flex items-center gap-2">
                <span className="sign text-[0.58rem] text-ink-500">{label}</span>
                <CopyButton text={code} />
            </div>
            <pre className="overflow-x-auto border border-shell-700 bg-shell-900 px-3 py-2 font-mono text-[0.7rem] leading-relaxed text-ink-300">
                {code}
            </pre>
        </div>
    );
}

export default function ToolsPage() {
    return (
        <div className="flex min-h-full flex-1 flex-col">
            <AppHeader meta={`${TOOLS.length} tools · one definition`} />

            <Page>
                <p className={`${MEASURE} mb-5 text-[0.95rem] leading-relaxed text-ink-300`}>
                    The copilot has no special access.{' '}
                    <span className="text-ink-100">
                        It calls the same {TOOLS.length} tools listed below
                    </span>
                    , and so can you — they are served over the Model Context Protocol
                    straight from this deployment. No clone, no database credentials,
                    no setup. Point a client at it and ask the plant a question.
                </p>

                <div className="space-y-5">
                    <Panel title="Connect a client" meta="read-only · synthetic data">
                        <div className="space-y-4">
                            <CommandBlock label="Claude Code" code={CLAUDE_CODE_CMD} />
                            <CommandBlock label="Claude Desktop · config" code={CLAUDE_DESKTOP_JSON} />
                            <p className="font-mono text-[0.68rem] leading-relaxed text-ink-500">
                                Then ask it something that needs more than one system — try{' '}
                                <span className="text-ink-300">
                                    &ldquo;what is driving scrap on the 4471 bracket?&rdquo;
                                </span>{' '}
                                Plant date is pinned to {DATASET_TODAY}. Running it over stdio
                                against your own database instead is documented in{' '}
                                <a
                                    href="https://github.com/nwcarlson-dev/foundry-ops-ai/blob/main/docs/MCP.md"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-brand-300 underline decoration-shell-600 underline-offset-2 hover:decoration-brand-300"
                                >
                                    docs/MCP.md
                                </a>
                                .
                            </p>
                        </div>
                    </Panel>

                    <Panel title="One definition, four consumers" meta="lib/tools/">
                        <pre className="overflow-x-auto font-mono text-[0.68rem] leading-relaxed text-ink-500">
{`            lib/tools/  ·  ${TOOLS.length} typed, read-only, parameterised SQL
                              │
        ┌─────────────────┬───┴───────────┬─────────────────┐
   app/api/chat      mcp/server.ts   app/api/mcp        tests/
   Claude loop       stdio MCP       HTTP MCP           42 assertions
        │                 │               │                 │
   this website     Claude Desktop   your client       CI`}
                        </pre>
                        <p className="mt-3 max-w-[68ch] font-mono text-[0.68rem] leading-relaxed text-ink-500">
                            The MCP servers are not a reimplementation. Both transports call the
                            same <span className="text-ink-300">registerFoundryTools</span>, over
                            the same registry the chat loop uses. Adding a tool reaches all four
                            consumers at once.
                        </p>
                    </Panel>

                    <Panel title="The tools" meta={`${TOOLS.length} · every one read-only`} flush>
                        <div className="divide-y divide-shell-800">
                            {TOOLS.map((tool) => {
                                const params = paramsOf(tool);
                                return (
                                    <div key={tool.name} className="px-4 py-3">
                                        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                                            <span className="flex shrink-0 gap-[3px] self-center">
                                                {tool.sources.map((s) => (
                                                    <span
                                                        key={s}
                                                        title={s}
                                                        className="block h-3.5 w-[3px] rounded-full"
                                                        style={{ background: SOURCE_COLOR[s] ?? 'var(--color-shell-600)' }}
                                                    />
                                                ))}
                                            </span>
                                            <span className="font-mono text-[0.82rem] text-ink-100">
                                                {tool.name}
                                            </span>
                                            <span className="font-mono text-[0.62rem] text-ink-500">
                                                {tool.sources.join(' + ')}
                                            </span>
                                        </div>

                                        <p className="mt-1.5 max-w-[80ch] text-[0.82rem] leading-relaxed text-ink-300">
                                            {tool.description}
                                        </p>

                                        {params.length > 0 && (
                                            <dl className="mt-2 grid grid-cols-[auto_auto_1fr] items-baseline gap-x-3 gap-y-1">
                                                {params.map((p) => (
                                                    <div key={p.name} className="contents">
                                                        <dt className="font-mono text-[0.68rem] text-brand-300">
                                                            {p.name}
                                                        </dt>
                                                        <dd className="font-mono text-[0.64rem] text-ink-500">
                                                            {p.type}
                                                            {p.required && (
                                                                <span style={{ color: 'var(--color-warn)' }}>
                                                                    {' '}required
                                                                </span>
                                                            )}
                                                        </dd>
                                                        <dd className="font-mono text-[0.64rem] text-ink-500">
                                                            {p.description ?? ''}
                                                        </dd>
                                                    </div>
                                                ))}
                                            </dl>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </Panel>
                </div>

                <PageNote>
                    Every tool is allowlisted by name, validated against a Zod schema before a
                    query runs, and parameterised into Postgres — there is no free-form SQL path
                    to reach, and no tool writes. Results are row-capped. The data is synthetic;
                    browse it under{' '}
                    <Link href="/data" className="text-brand-300 underline decoration-shell-600 underline-offset-2 hover:decoration-brand-300">
                        Source data
                    </Link>
                    .
                </PageNote>
            </Page>
        </div>
    );
}
