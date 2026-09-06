# Flow Engine (`src/flow.ts`)

A pure static flow solver: it propagates throughput through the
connection graph and reports per-machine efficiency, per-connection
flow, and health warnings. No DOM, no mutation — `solveFlow(state)`
reads editor state and returns a `FlowReport`. This is the foundation
for the auto-factory endgame: gas mode, split/merge accounting, and
future auto-planner validation all read from this report.

## Rates

All flow math is **per-minute**, normalized by `ratePerMin`
([logistics.ts](logistics.ts)). Catalog slots are per-minute for items
and per-second for fluids; a 0.1/s gas input is 6/min. Transport
capacity: belts 30/min (`ITEM_BELT_RATE`), pipes 120/min (`PIPE_RATE`)
— liquids and gases ride pipes identically (see
[endfield.wiki.gg/wiki/Flow_Rate](https://endfield.wiki.gg/wiki/Flow_Rate)).
Exceeding capacity **clogs** the line.

## Model

- **Sources** — machines whose active recipe has no inputs (mining rigs,
  Gas Extractors) and depots with an assignment produce at their full
  rate.
- **Recipe selection** — `selectBestRecipe` (recipes.ts): the recipe
  with the most fed input slots wins, so shared inputs (Amethyst Part)
  pick the right craft.
- **Efficiency** — scarcest input: `min(fed/demand)` over the recipe's
  input slots. Outputs scale by it, and the shortfall propagates
  downstream: a converter starved to 50% feeds the next stage at 50%.
- **Splitting** — supply is divided across outgoing lines for the same
  resource proportionally to consumer demand, capped per line. A
  Splitter machine (no recipe, multiple outputs) therefore divides
  round-robin style for free.
- **Converging** — multiple inbound lines sum up; supply beyond what the
  machine consumes saturates its lines and is flagged clogged. A
  Converger merging 2×30/min into one 30/min line runs at capacity and
  clogs.
- **Passthrough** — machines that don't consume a carried resource
  forward it (up to outgoing capacity); sinks accept everything.
- **Cycles** — Kahn's topological sort; machines left in cycles are
  flagged and solved conservatively from whatever flows in from outside
  the cycle. Never crashes.
- **Gas mode** — recipe slots with a `min` activation floor (per-minute)
  gate the machine **binary**: fed below the floor → efficiency 0 and an
  `inactive` warning; at or above it the machine runs, and gas offered
  past the slot's rate is absorbed and **wasted** (the feeding line never
  clogs — `consumerDemand` returns unbounded for such slots). See
  [reference/gas-system.md](../reference/gas-system.md) for the in-game
  behavior this encodes.

## FlowReport

```ts
interface FlowReport {
  machines: MachineFlow[];      // efficiency, per-slot fed/demand, outputs
  connections: ConnectionFlow[]; // flowPerMin vs capacityPerMin, clogged
  warnings: FlowWarning[];       // clogged | starved | stalled | cycle | inactive
}
```

## Where it surfaces

- `recipeInfo.ts` — `selectedRecipeFor` accepts a FlowReport; the recipe
  panel shows the propagated efficiency, not raw connection sums.
- `editor/redraw.ts` — solves once per redraw; the renderer draws an
  amber `!` badge on starved machines and a red `×` on clogged ones.
- `__ew.flow()` (agent API) — the full report as text; see
  [reference/agent-playground.md](../reference/agent-playground.md).

## Minimum-flow inputs

Gas machines with a dedicated activation input — the Gas Dispersing Unit
and both Fluid-/Solid-Gas Transmuting Units, at **6/min** in game — are
catalog slots with `min: 6` (per-minute). The gate is binary, not
proportional: fed 3/min means the machine is OFF (efficiency 0, warning
`inactive`), and feed past the slot's rate is wasted without clogging
the line. Details and the researched machine data:
[reference/gas-system.md](../reference/gas-system.md).

Related: [logistics.md](logistics.md) · [recipe-info.md](recipe-info.md) · [grid.md](grid.md)
