import { describe, expect, it } from 'vitest';
import { selectProduction } from '../src/planner/select.ts';
import { ratePerMin } from '../src/logistics.ts';
import type { MachineType, PlannerPlan } from '../src/types.ts';

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
});
