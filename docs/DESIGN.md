# Color direction: LeClaire's brand, in the dark

> **Status: applied.** Everything below is live in
> [`app/globals.css`](../app/globals.css) and the three page components, with
> one documented correction to the source-color table (see *Source colors*).
> The company name is deliberately **not** printed anywhere in the UI — the
> palette carries the recognition on its own, which is the point of the doc.

The goal is recognition, not replication. Someone from LeClaire Manufacturing
should open this and feel like it belongs to them within about a second — before
they read a word — and then stop thinking about the colors entirely.

That rules out two obvious approaches. Sampling the hex codes off
leclairemfg.com and dropping them onto a black shell doesn't work: their palette
is built for dark ink on white paper, and mid-blues that read as confident on
white go muddy and low-contrast on graphite. Going the other way — a white,
brochure-styled UI — throws away the reason this is dark in the first place.
This is a plant-floor tool that gets left open on a screen for hours; the dark
shell is an ergonomic decision, not a stylistic one.

So: **LeClaire's blue carries the identity, their red carries the alarm, and the
existing graphite shell stays — cooled slightly so the whole surface reads as
belonging to a blue brand rather than an orange one.**

## What we're matching

Sampled from the site header and hero band. Treat these as reference, not as
values to ship:

| Element | Approx. | Notes |
| --- | --- | --- |
| Logo wordmark | `#1B62A8` | The primary identity blue |
| Logo subtext | `#1F3E6E` | Deeper navy, secondary |
| Hero band | `#2E6DB4` | Brighter, large-area blue |
| "Request a Quote" / arrow buttons | `#D6382C` | Action + accent red |
| Nav type | `#333333` | Near-black on white |

Two things to carry forward beyond the hex codes. Their blue is a **deep,
slightly desaturated industrial blue** — not a tech-startup azure, not navy
either. And their red is used **once per screen, on the one thing they want you
to click**. Both of those habits matter more to the "familiar" feeling than
exact hue.

## Why the values change

Every color below was checked against the shell backgrounds it will actually sit
on. Ratios are against `--color-shell-900` (`#0b0e12`).

The headline problem: `#1B62A8` as text on the dark shell lands around **3.5:1**
— fine for a large heading, illegible as a label or a link. So the blue splits
into two roles. A **light blue** does all the work that touches type and icons.
A **deep blue** does all the work that is a surface, fill, or border, where the
contrast requirement runs the other way.

## The palette

### Shell — cool graphite

The current shell is neutral-warm. Shift it a few degrees cool. It is a subtle
change and it is the single thing that makes the blue accents feel native
instead of applied.

| Token | Current | Proposed |
| --- | --- | --- |
| `--color-shell-900` | `#0d0f11` | `#0b0e12` |
| `--color-shell-850` | `#131619` | `#10141a` |
| `--color-shell-800` | `#181b1f` | `#151a21` |
| `--color-shell-700` | `#21262b` | `#1e242d` |
| `--color-shell-600` | `#2d343a` | `#2a323d` |
| `--color-shell-500` | `#3d464e` | `#3a4451` |

Type gets the same cool shift: `ink-100 #eef2f6` (17.2:1), `ink-300 #b8c2ce`
(10.7:1), `ink-500 #7b8794` (5.3:1), `ink-600 #5a6472` (3.2:1 — decorative
only, never a label).

### Brand blue

| Token | Hex | On shell-900 | Use for |
| --- | --- | --- | --- |
| `--color-brand-300` | `#7fb4e8` | 8.8:1 | Links, active nav, icons, small blue type |
| `--color-brand-400` | `#4d93dd` | 6.0:1 | Hover states, secondary blue type |
| `--color-brand-500` | `#1f6fc4` | 3.8:1 | Headings, large type, focus rings, 1px borders |
| `--color-brand-600` | `#17539b` | 2.5:1 | **Fills only.** White type on it clears 6.8:1 |
| `--color-brand-800` | `#0f2b4d` | — | Tinted panel backgrounds; `ink-100` on it is 12.7:1 |

`brand-500` is the identity anchor — it is the one closest to their wordmark, and
it should be the color of the app's own logotype/header mark.

### Red

Keep LeClaire's red, but **reserve it entirely for alarm and exception state.**

| Token | Hex | On shell-900 |
| --- | --- | --- |
| `--color-danger` | `#f2554a` | 5.7:1 (type, icons) |
| `--color-danger-fill` | `#d9382c` | 4.2:1 (badges, bars; white on it is 4.6:1) |

This is the one deliberate departure from their site, and it's worth being
explicit about why. On leclairemfg.com red means *click here*. In an operations
copilot, red has to mean *something is wrong* — a scrap spike, a blocked job, a
reconciliation break. You cannot have both meanings live in the same interface;
the first time a user sees a red button next to a red alarm, the alarm stops
working. Blue takes over the primary-action job.

The recognizable red cue survives as **non-interactive brand trim**: a hairline
red rule under the app header, and a red underline on the active nav item. Same
visual note as their site, no semantic collision.

### Amber (`melt-*`)

Currently the primary accent — molten aluminum, the pour glow. **Demote it, keep
it.** It becomes:

- the `warn` tier, between blue-normal and red-alarm
- the body's top glow, dropped from `rgba(255,140,26,0.09)` to a blue
  `rgba(31,111,196,0.10)` so the ambient wash reads brand-blue instead of orange
- `::selection` moves from `melt-600` to `brand-600`
- inline `code` in `.answer` moves from amber to `brand-300` on a
  `rgba(31,111,196,0.10)` ground

Losing amber as the hero accent costs some of the foundry character. Blue on
graphite with red alarms is still unmistakably industrial — and it's *their*
industrial rather than generic-foundry.

### Source colors — one real collision

Provenance coloring is load-bearing here, and there's a conflict:
`--color-src-epicor` is `#4d94d1`, which is within a rounding error of
`brand-400 #4d93dd`. Once blue is the brand color, a blue number no longer
reliably means "this came from Epicor."

**Resolution:** keep Epicor's light blue for data, and confine brand blue on the
same screen to `brand-600`/`brand-800` — surfaces, fills, borders, chrome. Deep
navy structure and light-azure data points are far enough apart in lightness to
stay separable. Brand blue never becomes a data-series color, and Epicor blue
never becomes chrome.

If they still muddle in practice, the fallback is to move Epicor to a cyan
(`#5ec8e0`, 10.0:1) and give the blue entirely to the brand. That's a bigger
change — Epicor is the system of record and appears the most — so try the
discipline rule first.

The other three source colors are unaffected and stay: Thrive `#c1591d`,
Ignition `#149180`, Monday `#8d63bf`, xref `#8a949c`.

> **Corrected.** An earlier draft of this table listed Thrive `#f08c3a`,
> Ignition `#3fb87f`, and Monday `#b07de0`. Those are the *pre-validation*
> hues, and running them through the dataviz checker against the new shell
> fails the lightness band — all three land above L 0.67 (0.734, 0.701, 0.680)
> on a dark surface, which is what makes a dark UI look washed out. The values
> above are what actually ships, and they pass all five checks on `#10141a`
> with a worst adjacent pair of ΔE 10.9 under deuteranopia. Re-run before
> changing any of them:
>
> ```
> node scripts/validate_palette.js "#4d94d1,#c1591d,#149180,#8d63bf" \
>   --mode dark --surface "#10141a"
> ```

## Usage rules

1. **Blue is chrome and action.** Header, active nav, focus rings, primary
   buttons, links, selected rows, panel borders.
2. **Red is exception only.** Never a button, never a heading, never decoration.
   If a red thing on screen isn't a problem, it's wrong.
3. **Amber is warning.** The tier between fine and broken.
4. **One accent per view.** LeClaire's homepage has exactly one red button.
   Match that restraint — a dashboard with six competing accents reads as a
   consumer app, not an instrument.
5. **Color is never the only signal.** Every alarm carries an icon or a label
   too. Foundry floors have colorblind operators like everywhere else.
6. **Never fill a large area with `brand-600` at full saturation.** Big blue
   panels are what makes a dark UI look like a 2012 admin template. Tint with
   `brand-800` instead.

## Contrast floor

4.5:1 for anything under 18px, 3:1 for large type and for UI boundaries that
carry meaning (focus rings, chart axes, alarm borders). Every value above was
measured against the shell it sits on, not assumed. If a new color gets added,
measure it before it ships.

## Where this lands in code

All of it is token-level — [`app/globals.css`](../app/globals.css), the `@theme`
block plus the `body` glow, `::selection`, and the `.answer code` rule. Nothing
in [`app/chat.tsx`](../app/chat.tsx) or the components needs to change if the
token names are kept and only their values move; the new `brand-*` tokens are
additive.

---

# Layout: one frame, five routes

> **Status: applied.** Enforced by [`app/shell.tsx`](../app/shell.tsx) and three
> tokens in [`app/globals.css`](../app/globals.css).

Consistency here means every route is composed from the same primitives, so
structural elements land on the same pixel — not that the pages look roughly
alike. Before this, they did not: the copilot rendered the source bus inside the
`<header>`, which pushed the red rule to y=106 while the other four routes had
it at y=47, and it wrapped its body in an 80ch column with 48px of vertical
padding while everything else ran full width at 24px.

## The tokens

| Token | Value | What it fixes |
| --- | --- | --- |
| `--layout-max` | `90rem` (1440px) | The one container width. |
| `--layout-header-h` | `3rem` (48px) | The header row, so the red rule lands at y=49 on every route. |
| `--layout-pad-y` | `1.5rem` (24px) | Top and bottom padding of `<main>`. |

## The rules

1. **A page renders `<AppFrame>` and nothing outside it.** The frame owns the
   header, the container, the vertical rhythm, and the sticky footer slot. A
   page supplies content, an optional `meta` string, and nothing else.
2. **`SHELL` is not exported.** A page that cannot name the container cannot
   override it. No page sets `max-w-*`, page padding, or its own `<header>`.
3. **The header has no slot.** `AppHeader` is not exported and takes no
   children. Its row is exactly `--layout-header-h` tall and nothing inside it
   can wrap or grow — the nav scrolls sideways rather than taking a second line.
   Page-specific header-adjacent content (the source bus) goes in the page body,
   below the rule.
4. **Prose caps at 68ch, inside the container.** `PROSE` and `.answer` are a
   typographic measure, not a frame: no `mx-auto`, no `w-full`, so they can cap
   a line length but never narrow or centre the page.

## Verified

Measured in a real browser at 1440px, 1024px, and 390px, across `/`,
`/dashboard`, `/schedule`, `/data`, `/tools`, and the 404: header height 49px
(48px row + the 1px rule), rule at y=49, `<main>` frame equal to the viewport up
to the 1440px cap, and 24px of top padding — identical on every route at every
width.
