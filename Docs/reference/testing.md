# Testing (`test/`)

Unit tests run with **Vitest 2** in the `node` environment (no DOM,
no browser, no network). The test config lives in `vite.config.ts`
under the `test` key; vitest picks up `test/**/*.test.ts`.

## Running

```bash
# One-shot (CI / pre-push style)
npm test

# Watch mode while iterating
npm run test:watch

# Type-check only
npm run typecheck
```

The full suite is currently **117 tests** across ten files (see table).

## What's Covered

| File | Focus |
|---|---|
| `test/grid.test.ts` | `Grid` class: empty construction, `isWithinBounds`, `isFree`, `canPlace` for in-bounds / right-edge overflow / bottom-edge overflow / overlap, footprint fill on `placeMachine`, throw on invalid place, full clear on `removeMachine`, out-of-bounds reads, and `placeConnectionTiles` / `removeConnection` / `getConnectionAt` for the connection layer. |
| `test/geometry.test.ts` | `rotateSide` for representative (side, orientation) pairs, `transformPort` and `getPortTile` for the Miner and Furnace at all four orientations, plus `getAdjacentTile` for the four cardinal directions and a non-zero machine origin. |
| `test/pathfinding.test.ts` | `findPath`: same-cell start/end, straight horizontal and vertical paths, occupied start/end, routing around a wall of machines, fully enclosed destination, connection tiles as obstacles, and optimal Manhattan length. |
| `test/planner.test.ts` | Planner pipeline: select (quantization, activation floors, byproducts, recycle loops, raw inputs, ban/prefer, loads, diagnostics) → expand (nodes, line fan-out) → layout (rows, depot layer, determinism) → assignPorts/route (purity, idempotence) → buildPlan/validate (per-step efficiency end-to-end). |
| `test/flow.test.ts` | `solveFlow`: rate normalization, efficiency propagation, split/merge, clog/starve/stall/cycle/inactive warnings, gas min-flow gating. |
| `test/connections.test.ts` | `completeDraft`: direction validation, resource inference, auto-bridging, colinear rejection, gas pipes. |
| `test/agentDump.test.ts` | Agent text dump: ASCII map, machine/connection tables, JSON snapshot. |
| `test/gas-catalog.test.ts` | Gas catalog spot-checks: extractor rates, disperser floors, ENV map, transmuters, tanks. |
| `test/recipes.test.ts` / `test/recipeInfo.test.ts` | Recipe matching + recipe panel resolution. |
| `test/grid.test.ts` | (existing — unchanged) |

## Conventions

- **Imports use `.ts` extensions** to match the `allowImportingTsExtensions`
  setting in `tsconfig.json`. Vite and Vitest both resolve them
  transparently.
- **No DOM-mocking.** The editor logic that lives in `main.ts` is not
  unit-tested because it depends on the DOM. The pure functions
  (`Grid`, `geometry.ts`) are.
- **Tiny machine type in tests.** The tests use the real `MINER`
  definition from `src/data.ts` (5×5, single north port) to keep
  fixtures in sync with the catalog.

## Adding a Test

1. Create `test/<topic>.test.ts`.
2. Import the module under test (and `describe` / `it` / `expect`
   from `vitest`).
3. Add a `describe` block per concept, `it` per case.

Example skeleton:

```ts
import { describe, expect, it } from 'vitest';
import { Grid } from '../src/grid.ts';

describe('Grid.canPlace', () => {
  it('returns true for an empty in-bounds footprint', () => {
    const grid = new Grid(10, 10);
    expect(grid.canPlace(/* type */, 0, 0)).toBe(true);
  });
});
```

Vitest's `test` config in `vite.config.ts` will pick the file up
automatically. Run `npm test` to verify.

## Why Not Test `main.ts`?

`main.ts` is a thin DOM-glue layer. Testing it would require jsdom or
similar, and the value is low: the logic it owns (placement,
removal, rotation, bounding box) is exercised via the `Grid` and
`geometry` tests, which are where the bugs would actually live. If
`main.ts` ever grows non-trivial logic (drag-and-drop, multi-select,
undo), introduce jsdom-based tests then.

Related: [overview.md](../overview.md) · [grid.md](../core/grid.md) · [geometry.md](../core/geometry.md)
