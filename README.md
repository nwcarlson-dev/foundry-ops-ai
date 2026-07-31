# Foundry Ops Copilot

**Four plant systems. No shared keys. Ask them one question.**

**→ [foundry-ops-ai.vercel.app](https://foundry-ops-ai.vercel.app)** — live, no signup. Click
the first suggested question.

Or skip the UI and give the plant to your own agent — the same twelve tools, over MCP:

```bash
claude mcp add --transport http foundry-ops https://foundry-ops-ai.vercel.app/api/mcp
```

Epicor knows job numbers. Thrive knows heat numbers and its own pattern codes.
The Ignition historian knows tag paths and timestamps and nothing else. The
monday.com board knows whatever a human typed into a text field. None of them
share a key.

This answers questions that need more than one of them.

> **Scrap is up on the 4471 bracket. What's causing it, and is the customer expedite at risk?**
>
> Gas porosity is 41% of scrap on that part over 90 days, up from a 0.2/week
> baseline to 13/week *(Epicor)*. The heats behind job J-100864 ran degas at
> **6.2 min against a 12.0 min furnace baseline**, with RPT density at 2.524
> against 2.614 *(Thrive)* — and the Ignition historian independently records the
> same decay on Furnace 3. Deere has a **Stuck expedite promised tomorrow**
> *(monday.com)*, and the machining cell the job still has to pass through just
> logged 9.8 hours of unplanned downtime.
>
> Nobody changed a setpoint. The degas cycle timer drifted.

Epicor can tell you *that* scrap went up. Only the join tells you *why*, and only
the fourth system tells you a customer is about to be affected.

---

## Why this is the interesting problem

The job posting names Epicor, Thrive, Ignition/PaperlessLog, and monday.com, and
asks for *"a unified AI layer that can reason across them together."* Modelling
that as one tidy warehouse would dodge the actual problem.

So the four sources are four Postgres schemas that **share no keys**, each
carrying its real system's conventions. The `xref` schema is the bridge, and it
is the substance of the project:

| Bridge | Mechanism | Why it is hard |
|---|---|---|
| `epicor.part_num` ↔ `thrive.pattern_code` | hand-maintained lookup table | no system owns both namespaces; some parts were never mapped; one pattern serves two part numbers |
| `epicor.wc_code` ↔ `ignition.tag_path` | tag-prefix match **plus a job time window** | the historian carries no production identifier at all, so a mapping alone is not enough |
| `epicor.job_num` ↔ monday free text | `normalize_job_ref()` pattern recovery | humans typed `J-104829`, `J104829`, `104829`, `Job 104829`, blanks, and a stale `TBD` |

**Match rates run 88–95%, not 100%, on purpose.** A reconciliation layer that
claims a perfect match is one nobody in a plant would believe. `xref.unmatched`
surfaces every failure with a reason, and the copilot is instructed to cite it —
an answer that names its blind spot is worth more than one that quietly
under-reports.

## What you can click

| | |
|---|---|
| **Copilot** | Chat over a Claude tool-use loop. Every tool call renders as a chip showing which systems it read, and the source bus across the top lights up as the copilot reaches into each one. |
| **Source data** | All 23 relations across the four schemas, browsable. The receipt: if you suspect a number was invented, read the table it came from. Read-only and allowlisted — the relation name is checked against `information_schema` before it reaches SQL. |
| **Plant status** | Anomaly dashboard. Detection is deterministic SQL; the model writes one sentence per finding. Every card deep-links back into chat with the investigating question loaded. |
| **Week schedule** | Finite-capacity scheduler — earliest due date, setup-family grouping, capacity discounted by real downtime. What didn't fit is reported with the arithmetic. |
| **Tools** | All twelve tools with their schemas and source systems — and the one command that connects your own MCP client to this deployment. No clone, no credentials. |

## Architecture

```
   epicor.*        thrive.*        ignition.*        monday.*
   job cost        melt & QA       historian         commitments
   job_num         heat_num        tag_path          item_id
       \              |                |                /
        \             |                |               /
         ──────  xref: 3 bridges + unmatched view  ──────
                            │
              lib/tools/  ·  12 typed, read-only, parameterised SQL
           /          |            |             \
   app/api/chat  mcp/server.ts  app/api/mcp   lib/anomalies.ts
   Claude loop   stdio MCP      HTTP MCP      lib/scheduler.ts
        │             │             │          deterministic
    Copilot UI   Claude Desktop  your client  Dashboard · Schedule
```

**One tool layer, four consumers.** Neither MCP server is a reimplementation —
both call `registerFoundryTools` in [`lib/mcp.ts`](lib/mcp.ts) over the same
`TOOLS` registry the web chat uses. That is the "unified AI layer" claim
demonstrated rather than asserted.

The HTTP transport is the part you can check without taking any of this on
trust: point your own client at the running deployment and the twelve tools are
there.

```bash
claude mcp add --transport http foundry-ops https://foundry-ops-ai.vercel.app/api/mcp
```

## Two design decisions worth defending

**The model never writes SQL.** It selects a tool and supplies typed parameters,
validated against a Zod schema before any query runs, and every value reaches
Postgres as a bind parameter. There is no free-form query path. That is a
deliberate constraint, not a missing feature: a plant should not have to take it
on trust that a language model will not write a `DELETE`.

**The model never makes the decision.** Anomaly detection is z-scores and rate
comparisons in SQL. The scheduler is a dispatch rule against real capacity. Both
are deterministic and auditable; the model writes prose over numbers it did not
produce and cannot change. The schedule page says so in its own header:
*written by the model · schedule was not.*

## The data is synthetic, and that is documented

No real LeClaire data was used or available. Every row is generated from a fixed
seed by [`scripts/generate.ts`](scripts/generate.ts).

The realism claim is narrow and specific: **the structure, vocabulary, and
failure modes are real; the numbers are invented.** Tables follow Epicor
job-cost conventions. Scrap reason codes are the real vocabulary, and each defect
is attributed to a cause that actually produces it.

[**docs/DATA.md**](docs/DATA.md) is the full disclosure — the deliberate
reconciliation defects, all five planted signals, and a "what is not modelled"
section. Signal one is worth reading: under-degassed metal raises porosity on
*everything* poured from that furnace, graded by section thickness, because a
copilot that says *"it's furnace 3, worst on the heavy sections"* is more useful
than one that says *"it's the bracket."*

## Running it

```bash
npm install
cp .env.example .env.local        # add DATABASE_URL and ANTHROPIC_API_KEY

npm run seed                      # ~76k rows from a fixed seed, reproducible
npm run verify                    # 37 assertions: every planted signal detectable
npm test                          # 48 assertions: tools, both MCP transports, scheduler
npm run warm                      # pre-write the dashboard and schedule prose
npm run dev

npm run ask -- "which open jobs are at risk and why?"   # same loop, no browser
npm run mcp                                             # stdio MCP server
```

`warm` matters more than it looks. The dashboard's notes and the schedule's
explanation are the only model output on those pages, and both are cached in
Postgres against a fingerprint of the facts they describe. Generating them on
demand behind a module-level cache is what a single-server habit produces and
what serverless punishes: every request lands on a fresh isolated function, so
that cache was empty for nearly every visitor and each one waited **9.5 seconds**
for prose over numbers that were ready in 0.4s. Now neither page ever waits on a
model call — a cache miss renders the numbers immediately and fills the prose in
afterwards — and `warm` means the miss never happens.

### The tests are the point, not decoration

The failure that would actually damage this project is a copilot confidently
reporting a wrong number to someone who knows foundries. Every tool is
cross-checked against direct SQL. Between them, `verify` and `test` have caught:

- Thrive and Ignition reporting different degas values **for the same job** —
  furnace identity was drawn independently per system, which would have
  discredited exactly the corroboration the flagship answer rests on
- `job_cost_summary` inflating quantities ~4× by joining `job_head` to
  `job_oper` without rolling up to job level first
- `heat_history_for_job` double-counting heats, because `xref.job_heat` carries a
  row per pour — and the test's own cross-check had the same bug, so it agreed
- `at_risk_jobs` reporting everything on track while five jobs contended for one
  degraded machining cell; it now allocates capacity earliest-due-first
- `labor_efficiency` concluding *bad crew* where the truth was *wrong standard* —
  it judged by spread between operators, which sampling noise defeats. The right
  question is whether the **fastest** operator still misses the number
- the scheduler over-allocating a work centre by 0.1h through accumulated
  rounding, and its setup counters tallying transitions that never happened

## Cost control

It is a public URL with a billing account behind it, so: prompt caching on a
byte-stable system prompt, a hard cap on agent turns, a per-visitor daily quota
and a monthly token ceiling as counters in Postgres, and dashboard narratives
fingerprinted and cached. The dashboard and schedule work with no model call at
all (`?narrate=0`, `?explain=0`), and the UI warns before a visitor hits the wall
rather than presenting a text box that suddenly errors.

## How this maps to the role

| The posting asks for | Where it is |
|---|---|
| Claude API — prompt engineering, tool use, agentic workflows | [`lib/agent/`](lib/agent/) — streaming tool-use loop, cached system prompt, refusal handling |
| MCP servers | [`lib/mcp.ts`](lib/mcp.ts) on two transports — [`mcp/server.ts`](mcp/server.ts) stdio and [`app/api/mcp`](app/api/mcp/route.ts) streamable HTTP, both live and both under protocol tests. Connect your own client to the deployment. |
| SQL against real production databases | [`lib/tools/`](lib/tools/) — 12 parameterised, read-only tools over Epicor-shaped schemas |
| Connecting existing systems into a unified AI layer | [`db/xref.sql`](db/xref.sql) — the three bridges and the unmatched view |
| AI-assisted scheduling from job cost, capacity, and machine data | [`lib/scheduler.ts`](lib/scheduler.ts) |
| Dashboards surfacing anomalies and at-risk jobs | [`lib/anomalies.ts`](lib/anomalies.ts) |
| TypeScript / REST | Next.js App Router, streaming NDJSON |

## Stack

Next.js on Vercel · Neon Postgres · `@anthropic-ai/sdk` with `claude-sonnet-5` ·
`@modelcontextprotocol/sdk` · hand-rolled SVG charts on a palette validated for
colour-vision deficiency · no charting or markdown dependency.
