import { ratePerMin } from '../logistics.ts';
import { ALL_MACHINE_TYPES } from '../data/index.ts';
import type { MachineType, Recipe } from '../types.ts';
import type {
  PlannerDiagnostic,
  PlannerEdge,
  PlannerPlan,
  PlannerPolicy,
  PlannerStep,
} from './types.ts';
import type { PlannerTarget } from './types.ts';

/**
 * Backward-chaining production quantifier: given a desired output rate,
 * compute which machines (type + recipe + count) are needed and what
 * material flows between them. Pure — no grid, no DOM.
 *
 * Model:
 * - Demands are a worklist. Each demand is first satisfied from surplus
 *   (user-provided inputs and byproducts of already-chosen steps), then
 *   from a producing step, else it becomes a raw depot input.
 * - A step is (machine, recipe); later demands for the same resource
 *   grow that step's count instead of opening a duplicate.
 * - Machine count = ceil(demand / net per-machine output), where "net"
 *   subtracts the recipe's own consumption of its output resource — the
 *   Solid-Gas Transmuting Unit eats 6/min of its own Xiragen as
 *   activation flow, so it nets 24/min, not 30.
 * - Count increases re-enqueue input-slot deltas, so activation floors
 *   (RecipeSlot.min) and byproduct outputs propagate. A hard iteration
 *   guard turns genuinely divergent cycles into a note instead of a hang.
 */

interface Expansion {
  machine: MachineType;
  recipe: Recipe;
  /** Resource this step was opened for. */
  forResource: string;
  /** Accumulated per-minute demand on forResource. */
  demand: number;
  count: number;
  /** Output rate for forResource minus own consumption of it. */
  netPerMachine: number;
  /** Resources on the expansion path down to this step (loop detection). */
  ancestors: Set<string>;
}

interface ProducerOption {
  machine: MachineType;
  recipe: Recipe;
}

/** resource → all (machine, recipe) pairs producing it. */
function producerIndex(machineTypes: MachineType[]): Map<string, ProducerOption[]> {
  const index = new Map<string, ProducerOption[]>();
  for (const machine of machineTypes) {
    for (const recipe of machine.recipes) {
      for (const out of recipe.outputs) {
        if (out.resource.trim() === '') continue;
        const list = index.get(out.resource) ?? [];
        if (!list.some((o) => o.machine === machine && o.recipe === recipe)) {
          list.push({ machine, recipe });
        }
        index.set(out.resource, list);
      }
    }
  }
  return index;
}

/** Output rate for `resource` across the recipe's output slots. */
function outputRateFor(recipe: Recipe, resource: string): number {
  return recipe.outputs
    .filter((o) => o.resource === resource)
    .reduce((a, o) => a + ratePerMin(o), 0);
}

/**
 * Pick one recipe for a resource. Preference order: banned machines
 * excluded, preferred machines first, then recipes that don't feed on
 * themselves or on a chain that does (net-positive cycles only), then
 * fully-producible inputs, then lower total input rate, then smaller
 * footprint, then catalog order — deterministic in every tie.
 */
function chooseRecipe(
  resource: string,
  options: ProducerOption[],
  producers: Map<string, ProducerOption[]>,
  available: Map<string, number>,
  policy: PlannerPolicy,
  notes: string[],
  diagnostics: PlannerDiagnostic[],
): ProducerOption | null {
  const feedsOnSelf = (option: ProducerOption): boolean => {
    if (option.recipe.inputs.some((i) => i.resource === resource)) return true;
    return option.recipe.inputs.some((i) => {
      const upstream = producers.get(i.resource) ?? [];
      return (
        upstream.length > 0 &&
        upstream.every((u) => u.recipe.inputs.some((j) => j.resource === resource))
      );
    });
  };
  const isProducible = (resourceName: string): boolean =>
    producers.has(resourceName) || (available.get(resourceName) ?? 0) > 0;

  const banned = new Set((policy.ban ?? []).map((n) => n.toLowerCase()));
  const preferOrder = new Map((policy.prefer ?? []).map((n, i) => [n.toLowerCase(), i]));
  const viable = options.filter((o) => !banned.has(o.machine.name.toLowerCase()));
  if (viable.length === 0) {
    const msg = `${resource}: all producers are banned — treating as raw input.`;
    notes.push(msg);
    diagnostics.push({ code: 'no-producer', resource, message: msg });
    return null;
  }
  const scored = viable.map((option) => ({
    option,
    preferred: preferOrder.get(option.machine.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER,
    selfFeeding: feedsOnSelf(option),
    producible: option.recipe.inputs.every((i) => isProducible(i.resource)),
    inputRate: option.recipe.inputs.reduce((a, i) => a + ratePerMin(i), 0),
    footprint: option.machine.width * option.machine.height,
    order: options.indexOf(option),
  }));
  scored.sort(
    (a, b) =>
      a.preferred - b.preferred ||
      Number(a.selfFeeding) - Number(b.selfFeeding) ||
      Number(b.producible) - Number(a.producible) ||
      a.inputRate - b.inputRate ||
      a.footprint - b.footprint ||
      a.order - b.order,
  );
  const best = scored[0]!;
  if (best.selfFeeding) {
    const msg = `${resource}: only net-cycle recipes available — counts assume the loop sustains itself.`;
    notes.push(msg);
    diagnostics.push({ code: 'net-cycle', resource, message: msg });
  }
  if (viable.length > 1) {
    const others = scored.slice(1).map((s) => s.option.machine.name).join(', ');
    const msg = `${resource}: chose ${best.option.machine.name}; alternatives: ${others}.`;
    notes.push(msg);
    diagnostics.push({ code: 'recipe-choice', resource, message: msg });
  }
  return best.option;
}

/**
 * Compute the plan for `target`. `available` maps raw resource names to
 * per-minute rates the user provides from depots/conduits; anything not
 * producible and not available lands in the plan's `inputs`.
 */
export function selectProduction(
  target: PlannerTarget,
  available: Record<string, number> | PlannerPolicy = {},
  machineTypes: MachineType[] = ALL_MACHINE_TYPES,
): PlannerPlan {
  const policy: PlannerPolicy = isPolicy(available) ? available : { available };
  const seed = policy.seed ?? 0;
  const producers = producerIndex(machineTypes);
  const surplus = new Map<string, number>(Object.entries(policy.available ?? {}));
  const requiredInputs = new Map<string, { kind: 'item' | 'fluid'; perMin: number }>();
  const steps: Expansion[] = [];
  const stepByResource = new Map<string, number>();
  const notes: string[] = [];
  const diagnostics: PlannerDiagnostic[] = [];
  const queue: { resource: string; perMin: number; ancestors: Set<string> }[] = [
    { ...target, ancestors: new Set() },
  ];

  /** Grow (or open) a step and enqueue its input-slot deltas. */
  const expand = (resource: string, perMin: number, choice: ProducerOption, ancestors: Set<string>): void => {
    const existingIdx = stepByResource.get(resource);
    if (existingIdx !== undefined) {
      const ex = steps[existingIdx]!;
      ex.demand += perMin;
      grow(ex, queue);
      return;
    }
    const netPerMachine =
      outputRateFor(choice.recipe, resource) -
      choice.recipe.inputs
        .filter((i) => i.resource === resource)
        .reduce((a, i) => a + ratePerMin(i), 0);
    const ex: Expansion = {
      machine: choice.machine,
      recipe: choice.recipe,
      forResource: resource,
      demand: perMin,
      count: 0,
      netPerMachine,
      ancestors: new Set([...ancestors, resource]),
    };
    steps.push(ex);
    stepByResource.set(resource, steps.length - 1);
    grow(ex, queue);
  };

  const grow = (
    ex: Expansion,
    enqueue: { resource: string; perMin: number; ancestors: Set<string> }[],
  ): void => {
    if (ex.netPerMachine <= 1e-9) {
      const msg = `${ex.forResource}: recipe does not net-produce its output — step cannot be quantified.`;
      notes.push(msg);
      diagnostics.push({ code: 'unquantified', resource: ex.forResource, message: msg });
      return;
    }
    const newCount = Math.ceil(ex.demand / ex.netPerMachine - 1e-9);
    if (newCount <= ex.count) return;
    const delta = newCount - ex.count;
    ex.count = newCount;
    // Byproduct outputs of the added machines become surplus.
    for (const out of ex.recipe.outputs) {
      if (out.resource === ex.forResource) continue;
      surplus.set(out.resource, (surplus.get(out.resource) ?? 0) + delta * ratePerMin(out));
      const pending = requiredInputs.get(out.resource);
      if (pending) {
        const covered = Math.min(pending.perMin, delta * ratePerMin(out));
        pending.perMin -= covered;
        surplus.set(out.resource, (surplus.get(out.resource) ?? 0) - covered);
        if (pending.perMin <= 1e-9) requiredInputs.delete(out.resource);
      }
    }
    // Enqueue only the NEW machines' input demands.
    for (const slot of ex.recipe.inputs) {
      if (slot.resource === ex.forResource) continue; // internal to the step
      enqueue.push({
        resource: slot.resource,
        perMin: delta * ratePerMin(slot),
        ancestors: ex.ancestors,
      });
    }
  };

  let guard = 0;
  while (queue.length > 0) {
    if (++guard > 500) {
      const msg = 'expansion did not converge — divergent recipe cycle; remaining demands truncated.';
      notes.push(msg);
      diagnostics.push({ code: 'divergent', message: msg });
      break;
    }
    const demand = queue.shift()!;
    if (demand.perMin <= 1e-9) continue;

    // Recycle loops (canisters, bottles, activation gases) close on
    // themselves: a demand for a resource we're already expanding
    // upstream is the loop feeding itself, not new external demand —
    // the upstream step's count already sizes the loop. Skip it.
    if (demand.ancestors.has(demand.resource)) {
      const msg = `${demand.resource}: demand closes a recycle loop — loop throughput follows the producing step.`;
      notes.push(msg);
      diagnostics.push({ code: 'recycle-loop', resource: demand.resource, message: msg });
      continue;
    }

    // 1. Surplus first (user-provided or byproducts).
    const have = surplus.get(demand.resource) ?? 0;
    if (have > 0) {
      const used = Math.min(have, demand.perMin);
      surplus.set(demand.resource, have - used);
      demand.perMin -= used;
      if (demand.perMin <= 1e-9) continue;
    }

    // 2. An existing step producing this resource absorbs the demand.
    if (stepByResource.has(demand.resource)) {
      expand(demand.resource, demand.perMin, steps[stepByResource.get(demand.resource)!]!, demand.ancestors);
      continue;
    }

    // 3. Choose a producer, else it's a raw depot input.
    const options = producers.get(demand.resource) ?? [];
    if (options.length === 0) {
      const existed = requiredInputs.get(demand.resource);
      const cur = existed ?? {
        kind: guessKind(machineTypes, demand.resource),
        perMin: 0,
      };
      cur.perMin += demand.perMin;
      requiredInputs.set(demand.resource, cur);
      if (!existed) {
        diagnostics.push({ code: 'raw-input', resource: demand.resource, perMin: round1(cur.perMin), message: `${demand.resource}: no catalog producer — depot input.` });
      }
      continue;
    }
    const choice = chooseRecipe(demand.resource, options, producers, surplus, policy, notes, diagnostics);
    if (!choice) {
      const msg = `${demand.resource}: no viable recipe found.`;
      notes.push(msg);
      diagnostics.push({ code: 'no-producer', resource: demand.resource, message: msg });
      continue;
    }
    expand(demand.resource, demand.perMin, choice, demand.ancestors);
  }

  const availRecord = policy.available ?? {};
  for (const [resource, left] of surplus) {
    if (left > 1e-9 && !(resource in availRecord)) {
      const msg = `plan overproduces ${resource} by ${round1(left)}/min — route it to a sink or depot.`;
      notes.push(msg);
      diagnostics.push({ code: 'overproduce', resource, perMin: round1(left), message: msg });
    }
  }

  const planSteps: PlannerStep[] = steps.map((s, i) => ({
    id: `step-${i}`,
    machine: s.machine.name,
    recipeId: s.recipe.id,
    count: s.count,
    loadPerMachine: loadsFor(s.count, s.demand, s.netPerMachine),
  }));

  const planEdges: PlannerEdge[] = [];
  for (const [toIdx, ex] of steps.entries()) {
    for (const slot of ex.recipe.inputs) {
      if (slot.resource === ex.forResource) continue;
      const perMin = ex.count * ratePerMin(slot);
      const fromIdx = stepByResource.get(slot.resource);
      if (fromIdx !== undefined) {
        planEdges.push({ id: '', from: fromIdx, to: toIdx, fromStepId: '', toStepId: '', resource: slot.resource, kind: slot.kind, perMin });
      } else {
        planEdges.push({ id: '', from: null, to: toIdx, fromStepId: null, toStepId: '', resource: slot.resource, kind: slot.kind, perMin });
      }
    }
  }
  // Merge duplicate edges (same from/to/resource/kind).
  const merged = new Map<string, PlannerEdge>();
  for (const e of planEdges) {
    const k = `${e.from}|${e.to}|${e.resource}|${e.kind}`;
    const cur = merged.get(k);
    if (cur) cur.perMin += e.perMin;
    else merged.set(k, { ...e });
  }
  const edges = [...merged.values()].map((e, i) => ({
    ...e,
    id: `edge-${i}`,
    fromStepId: e.from === null ? null : `step-${e.from}`,
    toStepId: `step-${e.to}`,
    perMin: round1(e.perMin),
  }));

  return {
    version: 1,
    seed,
    target: { ...target },
    steps: planSteps,
    edges,
    inputs: [...requiredInputs.entries()].map(([resource, v]) => ({
      resource,
      kind: v.kind,
      perMin: round1(v.perMin),
    })),
    notes,
    diagnostics,
  };
}

function loadsFor(count: number, demand: number, net: number): number[] {
  if (count <= 0) return [];
  const full = count - 1;
  const remainder = demand - full * net;
  const loads: number[] = [];
  for (let i = 0; i < full; i++) loads.push(1);
  loads.push(Math.min(1, Math.max(0, remainder / net) || 1));
  return loads.map((v) => Math.round(v * 1000) / 1000);
}

function isPolicy(v: Record<string, number> | PlannerPolicy): v is PlannerPolicy {
  const r = v as PlannerPolicy;
  return 'available' in r || 'ban' in r || 'prefer' in r || 'weights' in r || 'seed' in r;
}

function guessKind(machineTypes: MachineType[], resource: string): 'item' | 'fluid' {
  for (const m of machineTypes) {
    for (const r of m.recipes) {
      const slot = r.inputs.find((i) => i.resource === resource) ?? r.outputs.find((o) => o.resource === resource);
      if (slot) return slot.kind;
    }
  }
  return 'item';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
