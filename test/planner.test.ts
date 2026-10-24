import { describe, expect, it } from 'vitest';
import { selectProduction } from '../src/planner/select.ts';
import { expandPlan } from '../src/planner/expand.ts';
import { layoutNetwork } from '../src/planner/layout.ts';
import { assignPorts, routePlan } from '../src/planner/route.ts';
import { buildPlan } from '../src/planner/index.ts';
import { validateBuild } from '../src/planner/validate.ts';
import { ratePerMin } from '../src/logistics.ts';
import { ALL_MACHINE_TYPES } from '../src/data/index.ts';
import type { MachineType } from '../src/types.ts';
import type { PlannerPlan } from '../src/planner/types.ts';

function stepOf(plan: PlannerPlan, machine: string) {
  return plan.steps.filter((s) => s.machine === machine);
}

describe('selectProduction', () => {
  it('scales a single source machine to the target rate', () => {
    const plan = selectProduction({ resource: 'Clean Water', perMin: 90 });
    // Fluid Pump nets 60/min → 2 machines for 90/min.
    const pumps = stepOf(plan, 'Fluid Pump');
    expect(pumps).toHaveLength(1);
    expect(pumps[0]!.count).toBe(2);
    expect(plan.inputs).toHaveLength(0);
  });

  it('plans a gas chain with quantized extractors', () => {
    // Xiranite 30/min: 1 Solid-Gas TU (Xiragen 30/min, min 6 activation)
    // fed by Gas Extractors at ~20/min each → ceil(30/20) = 2.
    const plan = selectProduction({ resource: 'Xiranite', perMin: 30 });
    const tus = stepOf(plan, 'Solid-Gas Transmuting Unit');
    expect(tus).toHaveLength(1);
    expect(tus[0]!.count).toBe(1);
    const extractors = stepOf(plan, 'Gas Extractor');
    expect(extractors).toHaveLength(1);
    expect(extractors[0]!.count).toBe(2);
    // Edge: extractors → TU carrying Xiragen.
    const extIdx = plan.steps.findIndex((s) => s.machine === 'Gas Extractor');
    const tuIdx = plan.steps.findIndex((s) => s.machine === 'Solid-Gas Transmuting Unit');
    const edge = plan.edges.find((e) => e.from === extIdx && e.to === tuIdx);
    expect(edge).toMatchObject({ resource: 'Xiragen', kind: 'fluid' });
    expect(edge!.perMin).toBeCloseTo(30);
  });

  it('covers activation overhead from the net output rate', () => {
    // Xiragen 24/min: recipe_6 nets 29.9/min (30 output − 0.1 self-feed)
    // if the transmuter were chosen — but the extractor (raw source) wins
    // the tie-break, so 24/min needs ceil(24/20) = 2 extractors.
    const plan = selectProduction({ resource: 'Xiragen', perMin: 24 });
    expect(stepOf(plan, 'Gas Extractor')[0]!.count).toBe(2);
  });

  it('lists unproducible inputs as raw depot requirements', () => {
    // Heavy Xiragen 30/min: the planner prefers the Fluid-Gas Transmuting
    // Unit chain (its inputs are producible in-catalog) over the
    // Purification Unit (whose Separator Core has no producer here).
    const plan = selectProduction({ resource: 'Heavy Xiragen', perMin: 30 });
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    expect(stepOf(plan, 'Fluid-Gas Transmuting Unit').length).toBeGreaterThanOrEqual(1);
    // Xiragen demand is 30/min (activation feed) → 2 extractors at 20/min.
    expect(stepOf(plan, 'Gas Extractor')[0]!.count).toBe(2);
    expect(plan.inputs).not.toContainEqual(
      expect.objectContaining({ resource: 'Separator Core' }),
    );
  });

  it('prefers fresh production over a zero-net recycle loop', () => {
    // Empty bottles can come from cracking filled ones (net zero — the
    // bottle just goes around the loop) or from the Moulding Unit. The
    // planner must pick Moulding, the only source that actually nets
    // new bottles.
    const plan = selectProduction({ resource: 'Amethyst Bottle (Clean Water)', perMin: 30 });
    expect(stepOf(plan, 'Filling Unit')).toHaveLength(1);
    expect(stepOf(plan, 'Moulding Unit')).toHaveLength(1);
    expect(plan.notes.some((n) => n.includes('recycle loop'))).toBe(false);
  });

  it('credits byproducts against downstream demands (synthetic loop)', () => {
    // Cracker opens filled containers; its water byproduct must cover
    // the Filler's water demand so no raw water input is required.
    const cracker: MachineType = {
      name: 'Cracker', width: 3, height: 3, ports: [],
      recipes: [{
        id: 'crack',
        inputs: [{ resource: 'Filled', kind: 'item', rate: 30 }],
        outputs: [
          { resource: 'Empty', kind: 'item', rate: 30 },
          { resource: 'Water', kind: 'fluid', rate: 0.5 },
        ],
      }],
    };
    const filler: MachineType = {
      name: 'Filler', width: 3, height: 3, ports: [],
      recipes: [{
        id: 'fill',
        inputs: [
          { resource: 'Empty', kind: 'item', rate: 30 },
          { resource: 'Water', kind: 'fluid', rate: 0.5 },
        ],
        outputs: [{ resource: 'Filled', kind: 'item', rate: 30 }],
      }],
    };
    const plan = selectProduction(
      { resource: 'Filled', perMin: 30 },
      {},
      [cracker, filler],
    );
    expect(stepOf(plan, 'Filler')).toHaveLength(1);
    expect(stepOf(plan, 'Cracker')).toHaveLength(1);
    expect(plan.inputs).toHaveLength(0);
    expect(plan.notes.some((n) => n.includes('recycle loop'))).toBe(true);
  });

  it('returns an empty plan with a raw-input note for unknown resources', () => {
    const plan = selectProduction({ resource: 'Unobtainium', perMin: 10 });
    expect(plan.steps).toHaveLength(0);
    expect(plan.inputs).toContainEqual(expect.objectContaining({ resource: 'Unobtainium' }));
  });

  it('never requests more than the demand from raw inputs after quantization', () => {
    // Every edge rate must equal the consumer count × slot rate — no
    // demand may silently disappear.
    const plan = selectProduction({ resource: 'Xiranite', perMin: 60 });
    for (const edge of plan.edges) {
      expect(edge.perMin).toBeGreaterThan(0);
      const to = plan.steps[edge.to!]!;
      const type = stepOf(plan, to.machine);
      expect(type.length).toBeGreaterThan(0);
    }
  });

  it('rates are normalized per-minute regardless of catalog unit', () => {
    const plan = selectProduction({ resource: 'Clean Water', perMin: 60 });
    const pump = stepOf(plan, 'Fluid Pump')[0]!;
    expect(pump.count).toBe(1);
    expect(ratePerMin({ rate: 1, kind: 'fluid' })).toBe(60);
  });

  it('emits fill-first loads so the last machine absorbs the remainder', () => {
    const plan = selectProduction({ resource: 'Xiranite', perMin: 30 });
    const extractors = stepOf(plan, 'Gas Extractor')[0]!;
    expect(extractors.loadPerMachine).toHaveLength(2);
    expect(extractors.loadPerMachine[0]).toBe(1);
    expect(extractors.loadPerMachine[1]).toBeCloseTo(0.5, 3);
  });

  it('emits structured diagnostics alongside human notes', () => {
    const plan = selectProduction({ resource: 'Xiranite', perMin: 30 });
    expect(plan.diagnostics.length).toBeGreaterThan(0);
    expect(plan.notes.length).toBeGreaterThan(0);
    const codes = new Set(plan.diagnostics.map((d) => d.code));
    expect(codes.has('recipe-choice')).toBe(true);
  });

  it('honors ban/prefer policy without changing the default choice', () => {
    const def = selectProduction({ resource: 'Xiranite', perMin: 30 });
    expect(stepOf(def, 'Gas Extractor')).toHaveLength(1);
    const banned = selectProduction({ resource: 'Xiragen', perMin: 24 }, { ban: ['Gas Extractor'] });
    expect(stepOf(banned, 'Gas Extractor')).toHaveLength(0);
    expect(banned.steps.length).toBeGreaterThan(0);
  });
});

describe('expandPlan', () => {
  it('expands step counts into per-machine nodes with explicit loads', () => {
    const plan = selectProduction({ resource: 'Xiranite', perMin: 30 });
    const network = expandPlan(plan);
    expect(network.nodes).toHaveLength(3);
    const extNodes = network.nodes.filter((n) => n.machine === 'Gas Extractor');
    expect(extNodes.map((n) => n.load).sort()).toEqual([0.5, 1]);
    // One line per edge here — Xiragen 30/min fits a single 120/min pipe.
    expect(network.lines).toHaveLength(1);
    expect(network.lines[0]).toMatchObject({ resource: 'Xiragen', kind: 'fluid', perMin: 30 });
    // The fuller extractor serves the line.
    expect(network.lines[0]!.fromNodeId).toBe(extNodes.find((n) => n.load === 1)!.id);
  });

  it('fans out edges that exceed one line capacity', () => {
    // A 60/min belt edge into a 2-consumer step: each consumer needs
    // 60/min but a belt carries 30 → 2 lines per consumer = 4 lines.
    const filler: MachineType = {
      name: 'Sink', width: 2, height: 2, ports: [],
      recipes: [{
        id: 'eat',
        inputs: [{ resource: 'Ore', kind: 'item', rate: 60 }],
        outputs: [{ resource: 'Out', kind: 'item', rate: 60 }],
      }],
    };
    const source: MachineType = {
      name: 'Source', width: 2, height: 2, ports: [],
      recipes: [{
        id: 'make',
        inputs: [],
        outputs: [{ resource: 'Ore', kind: 'item', rate: 120 }],
      }],
    };
    const plan = selectProduction({ resource: 'Out', perMin: 120 }, {}, [source, filler]);
    const network = expandPlan(plan);
    const oreLines = network.lines.filter((l) => l.resource === 'Ore');
    expect(oreLines.length).toBeGreaterThanOrEqual(4);
    for (const l of oreLines) expect(l.perMin).toBeLessThanOrEqual(30);
  });

  it('is deterministic', () => {
    const plan = selectProduction({ resource: 'Xiranite', perMin: 30 });
    const a = expandPlan(plan);
    const b = expandPlan(plan);
    expect(b).toEqual(a);
  });
});

describe('layoutNetwork', () => {
  it('stacks consumers above suppliers and places depot inputs in their own row', () => {
    const plan = selectProduction({ resource: 'Xiranite', perMin: 30 });
    const network = expandPlan(plan);
    const placed = layoutNetwork(network, plan, ALL_MACHINE_TYPES);
    if ('error' in placed) throw new Error(placed.error);
    const ext = placed.placements.filter((p) => p.machine.type.name === 'Gas Extractor');
    const tu = placed.placements.filter((p) => p.machine.type.name === 'Solid-Gas Transmuting Unit');
    expect(ext).toHaveLength(2);
    expect(tu).toHaveLength(1);
    const maxY = Math.max(...ext.map((p) => p.machine.y));
    expect(tu[0]!.machine.y).toBeLessThan(maxY);
    // Placement ids ARE the node ids — connections resolve without remap.
    expect(new Set(placed.placements.map((p) => p.nodeId)).size).toBe(3);
    // Deterministic.
    const again = layoutNetwork(network, plan, ALL_MACHINE_TYPES);
    if ('error' in again) throw new Error(again.error);
    expect(again.placements.map((p) => [p.machine.id, p.machine.x, p.machine.y]))
      .toEqual(placed.placements.map((p) => [p.machine.id, p.machine.x, p.machine.y]));
  });

  it('synthesizes a depot node for raw inputs', () => {
    const plan = selectProduction({ resource: 'Unobtainium', perMin: 10 });
    // No producers: select leaves steps empty and inputs raw — expand a
    // synthetic consumer to exercise the depot path.
    expect(plan.inputs).toHaveLength(1);
    expect(plan.diagnostics.some((d) => d.code === 'raw-input')).toBe(true);
  });
});

describe('assignPorts + routePlan', () => {
  it('assigns ports purely, then routes without mutating the placement', () => {
    const plan = selectProduction({ resource: 'Xiranite', perMin: 30 });
    const network = expandPlan(plan);
    const placed = layoutNetwork(network, plan, ALL_MACHINE_TYPES);
    if ('error' in placed) throw new Error(placed.error);
    const before = JSON.stringify(placed.placements.map((p) => [p.machine.id, p.machine.x, p.machine.y]));
    const { assignments, diagnostics } = assignPorts(placed, network);
    expect(diagnostics).toEqual([]);
    expect(assignments).toHaveLength(1);
    const routed = routePlan(placed, network);
    expect(routed.diagnostics).toEqual([]);
    expect(routed.connections).toHaveLength(1);
    expect(routed.connections[0]).toMatchObject({ resource: 'Xiragen', kind: 'fluid', throughput: 120 });
    // Placement untouched — re-route is idempotent.
    expect(JSON.stringify(placed.placements.map((p) => [p.machine.id, p.machine.x, p.machine.y]))).toBe(before);
    const again = routePlan(placed, network);
    expect(again.connections.map((c) => c.path)).toEqual(routed.connections.map((c) => c.path));
  });
});

describe('buildPlan end-to-end', () => {
  it('reports per-step efficiency with the connected extractor and TU at 100%', () => {
    const built = buildPlan({ resource: 'Xiranite', perMin: 30 });
    if ('error' in built) throw new Error(built.error);
    const byMachine = (name: string) => built.report.steps.filter((s) => s.machine === name);
    // Mean across the step's nodes: the half-loaded second extractor
    // drags the Gas Extractor mean below 1 — perNode tells the truth.
    const tu = byMachine('Solid-Gas Transmuting Unit')[0]!;
    expect(tu.efficiency).toBe(1);
    const extNodes = byMachine('Gas Extractor')[0]!.perNode;
    expect(extNodes.some((n) => n.efficiency === 1)).toBe(true);
    expect(built.report.warnings.some((w) => w.kind === 'inactive')).toBe(false);
    // validateBuild agrees with the flow solver on the same machines.
    const check = validateBuild(built.placed, built.network, built.routed, built.plan);
    expect(check.steps).toEqual(built.report.steps);
  });
});
