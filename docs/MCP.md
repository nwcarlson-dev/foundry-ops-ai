# Point Claude at the plant

The same twelve tools the web chat uses are exposed as an **MCP server** over
stdio. It is not a reimplementation — [`mcp/server.ts`](../mcp/server.ts) imports
the identical `TOOLS` registry from [`lib/tools/`](../lib/tools/) and wraps it in
a different transport.

That is the argument the project is making, in one file: build the integration
layer once, typed and allowlisted, and every surface gets it. The web chat, the
MCP server, and the test suite all call the same functions.

```
              lib/tools/  (12 typed, read-only, parameterised SQL)
                    |
        +-----------+-----------+
        |                       |
  app/api/chat            mcp/server.ts
  (Claude tool loop)      (stdio, any MCP client)
```

## Setup

Prerequisite: a working `.env.local` with `DATABASE_URL`, and a seeded database
(`npm run seed`). The server reads `.env.local` relative to its own location, so
it works regardless of which directory the client launches it from.

### Claude Desktop

Edit the config file:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "foundry-ops": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/TO/foundry-ops-ai/mcp/server.ts"]
    }
  }
}
```

Use an absolute path — Claude Desktop does not run from your project directory.
Restart Claude Desktop; `foundry-ops` should appear in the tools menu with twelve
tools.

### Claude Code

```bash
claude mcp add foundry-ops -- npx tsx /ABSOLUTE/PATH/TO/foundry-ops-ai/mcp/server.ts
```

### Verifying it works

```bash
npm run mcp        # should print: ready — 12 tools, plant date 2026-07-29
```

That line goes to **stderr**, deliberately. On a stdio MCP server stdout belongs
to the JSON-RPC stream, and a stray `console.log` corrupts it — the client then
disconnects with an opaque parse error that looks nothing like its cause. Every
log in the server writes to stderr for that reason.

The integration test in [`tests/mcp.test.ts`](../tests/mcp.test.ts) spawns the
server as a real subprocess and speaks the actual protocol to it, which is what
catches that class of bug:

```bash
npm test
```

## What Claude can ask it

All twelve tools are read-only and marked as such via MCP annotations
(`readOnlyHint: true`, `destructiveHint: false`), so a client can reason about
safety without inspecting the implementation.

| Tool | Reads from |
|---|---|
| `get_open_jobs`, `get_job_detail`, `scrap_by_reason`, `scrap_trend`, `labor_efficiency`, `job_cost_summary` | Epicor |
| `at_risk_jobs`, `work_center_load` | Epicor + Ignition + xref |
| `heat_history_for_job` | Epicor + Thrive + xref |
| `machine_signal_for_job` | Epicor + Ignition + xref |
| `customer_commitments_for_job` | Epicor + monday + xref |
| `reconciliation_report` | all four + xref |

Because an MCP client has no source-system chips to render, each tool's
description declares what it reads from, and every result payload carries a
`sources` array alongside the data.

Questions worth trying once connected:

- *Scrap is up on the 4471 bracket. What is causing it, and is the customer expedite at risk?*
- *Which open jobs are at risk of missing their due date, and why?*
- *Pull the heat history for J-100864 and tell me if degassing looks normal.*
- *How well do the four source systems reconcile, and what does not match?*

## A note on the read-only design

The model never writes SQL. It selects a tool and supplies typed parameters,
which are validated against a Zod schema before any query runs, and every value
reaches Postgres as a bind parameter. There is no free-form query path, so there
is nothing to inject through and nothing that could mutate plant data.

That is a deliberate constraint rather than a missing feature. A plant should not
have to take it on trust that a language model will not write a `DELETE`.
