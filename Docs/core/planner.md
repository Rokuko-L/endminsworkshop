# Planner (`src/planner/`)

Deterministic, headless-testable factory synthesis: a high-level request
("produce 30 Xiranite/min") becomes placed machines + routed connections
with no LLM in the loop. The agent API (`__ew.plan` / `__ew.buildPlan`)
is a thin debug surface over this pipeline, not the mechanism.

## The five artifacts

Each stage is a pure function over JSON-serializable artifacts with
stable IDs (`step-0`, `node-3`, `line-7`, `edge-0`) — edit any artifact
and resume downstream without re-running the world:

```
target + policy → Plan → Network → Placed → Routed → Report
```

| Artifact | Produced by | Shape |
|---|---|---|
| `PlannerPlan` | `selectProduction` ([select.ts](../../src/planner/select.ts)) | Aggregated WHAT: steps (machine + recipe + count + `loadPerMachine`), edges (step-index totals), depot inputs, notes + machine-readable `diagnostics` |
| `PlannerNetwork` | `expandPlan` ([expand.ts](../../src/planner/expand.ts)) | Physical WHICH: one `PlanNode` per machine (fill-first `load`), one `FlowLine` per routable line (never exceeds belt 30 / pipe 120 — oversized edges fan out) |
| `PlacedNetwork` | `layoutNetwork` ([layout.ts](../../src/planner/layout.ts)) | WHERE: placements whose ids ARE the node ids, on a fresh `Grid`; depot-sourced lines get synthesized depot machines on their own bottom row |
| `RoutedNetwork` | `assignPorts` + `routePlan` ([route.ts](../../src/planner/route.ts)) | HOW: port assignments (pure, no A*) then criticality-ordered `completeDraft` routing on a scratch grid — input placement never mutated |
| `BuildReport` | `validateBuild` ([validate.ts](../../src/planner/validate.ts)) | PROOF: `solveFlow` mapped back to per-step efficiency (`byStep` + `perNode`), warnings carried through |

`buildPlan(target, policy)` in [index.ts](../../src/planner/index.ts)
runs all five in one call (`__ew.buildPlan` materializes the result onto
the live grid). Canonical shapes live in
[types.ts](../../src/planner/types.ts); `PlannerPolicy`
(`available` / `ban` / `prefer` / `weights` / `seed`) steers recipe
choice without code edits.

## Design rules

- **One routing truth.** Routing reuses the editor's `completeDraft`
  (kind/resource validation, one-connection-per-tile, perpendicular
  crossings, A*). There is no second router to drift.
- **Fill-first loads.** `count = ceil(demand / net)`; machines 0..N-2 run
  at 1.0, the last absorbs the remainder (2 extractors for 30/min Xiragen
  → `[1, 0.5]`). `expandPlan` serves fuller sources first, so the
  half-loaded machine is visibly the spare — not a mystery stall.
- **Deterministic.** Catalog order decides every tie; artifacts carry
  `seed`; golden tests pin placements and paths.
- **Errors are data.** `diagnostics: { code, resource?, perMin?,
  message }[]` (`recipe-choice`, `net-cycle`, `recycle-loop`,
  `overproduce`, `divergent`, `raw-input`, `unquantified`,
  `no-producer`) — Phase 4 optimizes against codes, not English.

## Known limitations

- Raw depot inputs are *placed* (synthesized tank/unloader row) but not
  *fed* — validate assigns them infinite supply so downstream solves.
- Orientation search only tries 0°/180° for N/S-band machines, on
  Manhattan band-center span — cheap, not A*-optimal. Full port-facing
  optimization is deferred until ports are verified against in-game
  screenshots.
- Phase 4 (SA/hill-climbing on `weights`) and pylon placement are
  deliberately deferred for the same reason.

Related: [overview.md](../overview.md) · [flow.md](flow.md) ·
[logistics.md](logistics.md) · [agent-playground.md](../reference/agent-playground.md)
