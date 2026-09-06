import { describe, expect, it } from 'vitest';
import { ratePerMin } from '../src/logistics.ts';
import {
  GAS_DISPERSING_UNIT,
  GAS_REACTOR_GLOBE,
  FLUID_GAS_TRANSMUTING_UNIT,
  SOLID_GAS_TRANSMUTING_UNIT,
} from '../src/data/index.ts';
import { GAS_EXTRACTOR, FLUID_PUMP } from '../src/data/index.ts';
import { GAS_TANK } from '../src/data/index.ts';

/** Guards the researched gas-machine facts (see Docs/reference/gas-system.md). */
describe('gas catalog', () => {
  it('Gas Extractor: 3x3, no power, ~20/min output, fluid band out', () => {
    expect(GAS_EXTRACTOR.width).toBe(3);
    expect(GAS_EXTRACTOR.height).toBe(3);
    expect(GAS_EXTRACTOR.noPower).toBe(true);
    expect(GAS_EXTRACTOR.edgeBands?.south).toMatchObject({ type: 'output', resourceKind: 'fluid' });
    for (const recipe of GAS_EXTRACTOR.recipes) {
      expect(recipe.outputs).toHaveLength(1);
      expect(ratePerMin(recipe.outputs[0]!)).toBeCloseTo(20);
    }
  });

  it('Fluid Pump: Clean Water at 60/min', () => {
    const out = FLUID_PUMP.recipes[0]!.outputs[0]!;
    expect(out.resource).toBe('Clean Water');
    expect(ratePerMin(out)).toBe(60);
  });

  it('Gas Dispersing Unit: 3x3, 6/min activation floors, researched gas→ENV map', () => {
    expect(GAS_DISPERSING_UNIT.width).toBe(3);
    const envOf = Object.fromEntries(
      GAS_DISPERSING_UNIT.recipes.map((r) => [r.inputs[0]!.resource, r.env]),
    );
    expect(envOf).toEqual({
      Inergen: 'stable',
      Aquagen: 'humid',
      Acridgen: 'acrid',
      Xiragen: 'xiranite',
    });
    for (const recipe of GAS_DISPERSING_UNIT.recipes) {
      expect(recipe.inputs[0]!.min).toBe(6);
      expect(ratePerMin(recipe.inputs[0]!)).toBe(6);
    }
  });

  it('Gas Reactor Globe needs Acrid ENV for its Pyrrolite Gas reaction', () => {
    expect(GAS_REACTOR_GLOBE.recipes[0]!.env).toBe('acrid');
    expect(GAS_REACTOR_GLOBE.recipes[0]!.outputs[0]!.resource).toBe('Pyrrolite Gas');
  });

  it('transmuting units gate every recipe behind a 6/min activation flow', () => {
    for (const unit of [FLUID_GAS_TRANSMUTING_UNIT, SOLID_GAS_TRANSMUTING_UNIT]) {
      for (const recipe of unit.recipes) {
        const activation = recipe.inputs.find((s) => s.min !== undefined);
        expect(activation, `${unit.name} ${recipe.id}`).toBeDefined();
        expect(activation!.min).toBe(6);
      }
    }
  });

  it('Gas Tank mirrors the Fluid Tank port layout', () => {
    expect(GAS_TANK.ports.map((p) => [p.type, p.side, p.kind])).toEqual([
      ['input', 'east', 'fluid'],
      ['output', 'west', 'fluid'],
    ]);
  });
});
