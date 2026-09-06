# The Gas System — Research & Model

Reference for how gases work in Arknights: Endfield and how this planner
models them. Facts were gathered from the community wikis ([Endfield Talos
Wiki](https://endfield.wiki.gg), [Game8](https://game8.co/games/Arknights-Endfield))
and community flow-rate measurements; each machine below notes what is
confirmed vs. inferred. Guards against regressions live in
`test/gas-catalog.test.ts`.

## Pipeline rules (confirmed)

- Belts move **30/min** (1 item / 2s); pipes move **120/min** (2 units/s).
  Gases and liquids share the same pipe type and rate —
  [wiki Flow Rate](https://endfield.wiki.gg/wiki/Flow_Rate).
- Exceeding capacity clogs the line. Machines hold output until the line
  clears.
- Pipes may cross other lines only perpendicular (over/under pass);
  running along another line is illegal. The planner's router enforces
  this for both belts and pipes (`src/connections.ts`,
  `src/pathfinding.ts` — `CROSSING_COST` makes bridges a last resort).
  No in-game turning-radius rule is documented; none is modeled.

## Gas resources

| Gas | Made by | Consumers |
|---|---|---|
| Inergen | Gas Extractor (Inergen vents, Yinglung Pass) | Gas Dispersing Unit (Stable ENV), Moulding & Filling Units (canisters) |
| Xiragen | Gas Extractor (Xiragen reservoirs, North Wuling EZ); Fluid-/Solid-Gas Transmuting Units | Activation gas for both Transmuting Units, Gas Dispersing Unit (Xiranite ENV), Gas Reactor Globe, Purification Unit, Filling Unit |
| Acridgen | Fluid-Gas Transmuting Unit (from Precipitation Acid), Separating Unit | Gas Dispersing Unit (Acrid ENV), Filling Unit |
| Aquagen | Fluid-Gas Transmuting Unit (from Clean Water) | Gas Dispersing Unit (Humid ENV — waters farming plots) |
| Hetonite Gas | Purification Unit (Stable ENV), Solid-Gas Transmuting Unit | Gas Reactor Globe, Fluid-Gas Transmuting Unit, Solid-Gas Transmuting Unit |
| Cuprium Gas | Solid-Gas Transmuting Unit, Fluid-Gas Transmuting Unit | Purification Unit (Stable ENV), Fluid-/Solid-Gas Transmuting Units |
| Pyrrolite Gas | Gas Reactor Globe (Acrid ENV) | Solid-Gas Transmuting Unit, Gas Dispersing Unit recipes in older catalogs are superseded — venting Xiragen makes Xiranite ENV |
| Heavy Xiragen | Purification Unit (Stable ENV: 2 Xiragen + Separator Core) | Fluid-/Solid-Gas Transmuting Units |

## Machines (footprints & rates)

| Machine | Footprint | Power | Ports | Rate data |
|---|---|---|---|---|
| Gas Extractor | **3x3** (Game8) | none (natural flow) | fluid output band (side: project convention, unverified) | ~20/min (1 gas / 3s, community-measured); sits on Gas Vents |
| Fluid Pump | 5x5 (project) | **yes** | fluid output band (convention) | Clean Water 60/min (2u, wiki) |
| Gas Tank | 3x3 | none | fluid in (east) / out (west), mirrors Fluid Tank | buffers 500 units of one gas (Game8) |
| Gas Dispersing Unit | **3x3** (Game8) | unlisted | fluid input band | ≥6/min activation, excess wasted; 13x13 ENV aura |
| Gas Reactor Globe | 5x5 (Game8) | 50 (wiki.gg) | fluid in (south) / out (north, convention) | 60 Hetonite Gas + 30 Xiragen → 30 Pyrrolite Gas, **Acrid ENV required** |
| Fluid-Gas Transmuting Unit | 5x5 | unlisted | fluid in (south) / out (north, convention) | bidirectional liquid↔gas pairs at 30/min; **≥6/min Liquid Xiranite activation** |
| Solid-Gas Transmuting Unit | 5x5 (Game8) | unlisted | fluid in (south) / out (north, convention) | solid↔gas pairs; **≥6/min Xiragen activation** (even to make Xiragen itself) |

Port sides marked "convention" follow this project's `edgeBands` layout
(input south / output north, storage east→west) — the wikis do not
document exact port tiles; adjust if in-game screenshots say otherwise.

## Quirks modeled by the planner

1. **Minimum-flow activation** (`RecipeSlot.min`, per-minute): machines
   with a dedicated min-flow input — the Gas Dispersing Unit and both
   Transmuting Units ([wiki Flow Rate](https://endfield.wiki.gg/wiki/Flow_Rate),
   "at least 6 units/minute … to be active") — switch **binary**: below
   the floor the machine is inactive (solver warning `inactive`), never
   proportionally throttled. Intake past the slot's rate is absorbed and
   **wasted** rather than clogging the feeding line.
   For the Solid-Gas Transmuting Unit the activation gas is Xiragen —
   including for its Xiranite→Xiragen recipe, which is why the community
   joke "you need Xiragen to produce Xiragen" holds: net +24/min from a
   6/min activation feed.
2. **Environment requirements** (`Recipe.env`): the Gas Dispersing Unit
   vents gas into a **13x13** aura (must not overlap another unit's) that
   enables recipes inside it — Inergen → Stable, Aquagen → Humid,
   Acridgen → Acrid, Xiragen → Xiranite (Game8). Affected recipes:
   Gas Reactor Globe (Acrid), Purification Unit Heavy Xiragen / Hetonite
   Gas (Stable), Forge of the Sky Xiranite (Stable). The solver does not
   model auras spatially; the requirement is shown in the recipe panel
   (`Requires … ENV`).
3. **Byproducts**: Separating/Purification Unit outputs (canister
   recycling, Clean Water effluent split) are plain multi-output recipes —
   the solver already scales every output by the machine's efficiency.

## Where the model lives

- Catalog: `src/data/resourcing.ts` (Gas Extractor, Fluid Pump),
  `src/data/depot-access.ts` (Gas Tank), `src/data/production-ii.ts`
  (Dispersing Unit, Globe, Transmuting Units, ENV flags).
- Solver: `src/flow.ts` — gas mode (min-flow gates, waste absorption,
  `inactive` warnings).
- Types: `RecipeSlot.min`, `Recipe.env`, `EnvKind` in `src/types.ts`.
- Panel: `src/recipeInfoUi.ts` renders the ENV line and `≥min/min` floors.
