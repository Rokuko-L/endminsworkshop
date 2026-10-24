import { Grid } from '../grid.ts';
import { effectiveSize } from '../geometry.ts';
import { expandPlan } from './expand.ts';
import type { MachineInstance, MachineType, Orientation } from '../types.ts';
import type { NetworkPlacement, PlacedNetwork, PlannerNetwork, PlannerPlan } from './types.ts';

/**
 * Constructive layout for a PlannerNetwork: topological layers rendered
 * as horizontal rows, sources at the bottom and consumers stacked
 * upward. Pure — builds a fresh Grid, never mutates its input.
 *
 * - Offline depot nodes: `expandPlan` leaves depot-sourced lines with
 *   `fromNodeId: null`. Layout synthesizes one depot machine per
 *   consumed resource (Fluid/Gas Tank for fluids, Depot Unloader for
 *   items) on its own layer below everything else, so every line has a
 *   physical source and `from: null` is placed, not skipped.
 * - Orientation search: N/S-band machines try 180° when it shortens the
 *   port-to-port span to their consumers; the search is Manhattan on
 *   band-center tiles, not A* — cheap, deterministic, routing-blind no
 *   longer. Disabled via `opts.orientations: false`.
 * - Deterministic: BFD-ish ordering within rows, fixed gaps, seeded ids.
 */

export interface LayoutOpts {
  gap?: number;
  /** Try 180° for N/S-band machines. Default true. */
  orientations?: boolean;
  seed?: number;
}

const MARGIN = 2;
const DEFAULT_GAP = 3;

interface RowItem {
  nodeId: string;
  stepId: string;
  type: MachineType;
  sortKey: string;
  order: number;
}

interface DepotSpec {
  resource: string;
  kind: 'item' | 'fluid';
}

export function layoutPlan(
  plan: PlannerPlan,
  machineTypes: MachineType[],
  opts: LayoutOpts = {},
): PlacedNetwork | { error: string } {
  return layoutNetwork(expandPlan(plan, opts.seed ?? plan.seed), plan, machineTypes, opts);
}

/** Layout entry point for an expanded network (preferred). */
export function layoutNetwork(
  network: PlannerNetwork,
  plan: { steps: { id: string; machine: string }[] },
  machineTypes: MachineType[],
  opts: LayoutOpts = {},
): PlacedNetwork | { error: string } {
  const seed = opts.seed ?? network.seed ?? 0;
  const gap = opts.gap ?? DEFAULT_GAP;
  const byName = new Map(machineTypes.map((t) => [t.name, t]));
  const byStep = new Map(plan.steps.map((s) => [s.id, s]));

  for (const node of network.nodes) {
    if (!byName.has(node.machine)) return { error: `Unknown machine type '${node.machine}'.` };
  }

  // Offline depot specs: one synthesized machine per (resource, kind)
  // consumed from `fromNodeId: null` lines.
  const depotNeeds = new Map<string, DepotSpec>();
  for (const line of network.lines) {
    if (line.fromNodeId !== null) continue;
    const key = `${line.kind}:${line.resource}`;
    if (!depotNeeds.has(key)) depotNeeds.set(key, { resource: line.resource, kind: line.kind });
  }
  const depotTypeFor = (kind: 'item' | 'fluid'): MachineType | undefined =>
    byName.get(kind === 'fluid' ? 'Gas Tank' : 'Depot Unloader') ??
    [...byName.values()].find((t) => t.category === 'Depot Access');

  // Step layers: longest path over step edges; depot layer is -1.
  const producersOf = new Map<string, string[]>();
  for (const node of network.nodes) {
    const stepId = node.stepId;
    if (!producersOf.has(stepId)) producersOf.set(stepId, []);
  }
  const stepEdges: { from: string | null; to: string }[] = [];
  const seen = new Set<string>();
  for (const line of network.lines) {
    const toStep = network.nodes.find((n) => n.id === line.toNodeId)?.stepId;
    const fromStep = line.fromNodeId === null
      ? null
      : network.nodes.find((n) => n.id === line.fromNodeId)?.stepId ?? null;
    if (!toStep) continue;
    const key = `${fromStep}|${toStep}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stepEdges.push({ from: fromStep, to: toStep });
    if (fromStep !== null) producersOf.set(toStep, [...(producersOf.get(toStep) ?? []), fromStep]);
  }

  const layerOf = new Map<string, number>();
  const layer = (stepId: string, visiting: Set<string>): number => {
    const cached = layerOf.get(stepId);
    if (cached !== undefined) return cached;
    if (visiting.has(stepId)) return 0;
    visiting.add(stepId);
    let depth = 0;
    for (const p of producersOf.get(stepId) ?? []) {
      depth = Math.max(depth, layer(p, visiting) + 1);
    }
    visiting.delete(stepId);
    layerOf.set(stepId, depth);
    return depth;
  };
  for (const step of plan.steps) layer(step.id, new Set());
  const stepCount = plan.steps.length;
  const layerCount = stepCount === 0 ? 1 : Math.max(0, ...layerOf.values()) + 1;
  // +1 row when depots exist (layer -1 below layer 0).
  const rows: RowItem[][] = Array.from(
    { length: layerCount + (depotNeeds.size > 0 ? 1 : 0) },
    () => [],
  );
  const depotRow = depotNeeds.size > 0 ? 0 : -1;
  const rowForLayer = (l: number): number => l + (depotNeeds.size > 0 ? 1 : 0);

  let order = 0;
  for (const [key, spec] of depotNeeds) {
    const type = depotTypeFor(spec.kind);
    if (!type) return { error: `No depot machine available for ${spec.kind} '${spec.resource}'.` };
    const nodeId = `node-depot-${key.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
    if (depotRow >= 0) {
      rows[depotRow]!.push({ nodeId, stepId: `depot:${spec.resource}`, type, sortKey: spec.resource, order: order++ });
    }
  }

  for (const node of network.nodes) {
    const step = byStep.get(node.stepId);
    if (!step) return { error: `Unknown step '${node.stepId}'.` };
    const type = byName.get(node.machine)!;
    rows[rowForLayer(layerOf.get(node.stepId) ?? 0)]!.push({
      nodeId: node.id,
      stepId: node.stepId,
      type,
      sortKey: `${node.stepId}:${node.index}`,
      order: order++,
    });
  }

  // BFD-ish: taller (then wider) footprints first for compact packing.
  // Depot row keeps resource order so line→depot mapping is stable.
  for (let r = 0; r < rows.length; r++) {
    if (r === depotRow) {
      rows[r]!.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      continue;
    }
    rows[r]!.sort(
      (a, b) =>
        b.type.height - a.type.height ||
        b.type.width - a.type.width ||
        a.type.name.localeCompare(b.type.name) ||
        a.order - b.order,
    );
  }

  // Orientation pass: for machines whose type exposes exactly N/S bands,
  // flipping 180° can face the band toward the row above/below where its
  // consumers/suppliers sit. Compare band-center Manhattan span both
  // ways, keep the shorter. Deterministic, no A*.
  const useOrientations = opts.orientations ?? true;
  const orientationOf = new Map<string, Orientation>();
  if (useOrientations) {
    fillOrientations(orientationOf, rows, network);
  }

  const effSize = (type: MachineType, nodeId: string) =>
    effectiveSize(type, orientationOf.get(nodeId) ?? 0);
  const rowHeight = rows.map((row) =>
    Math.max(1, ...row.map((i) => effSize(i.type, i.nodeId).height)));
  const rowWidth = rows.map((row) =>
    row.reduce((a, inst) => a + effSize(inst.type, inst.nodeId).width, 0) +
    Math.max(0, row.length - 1) * gap);

  const width = Math.max(1, ...rowWidth) + MARGIN * 2;
  const height = rowHeight.reduce((a, h) => a + h, 0) + Math.max(0, rows.length - 1) * gap + MARGIN * 2;
  const grid = new Grid(width, height);

  const placements: NetworkPlacement[] = [];
  let y = height - MARGIN;
  for (let r = 0; r < rows.length; r++) {
    y -= rowHeight[r]!;
    let x = MARGIN;
    for (const inst of rows[r]!) {
      const size = effSize(inst.type, inst.nodeId);
      const machine: MachineInstance = {
        id: inst.nodeId.startsWith('node-depot-') ? inst.nodeId : inst.nodeId,
        type: inst.type,
        x,
        y: y + (rowHeight[r]! - size.height), // bottom-align within the row
        orientation: orientationOf.get(inst.nodeId) ?? 0,
      };
      grid.placeMachine(machine);
      placements.push({
        nodeId: inst.nodeId,
        stepId: inst.stepId,
        source: inst.nodeId.startsWith('node-depot-')
          ? { kind: 'depot', input: inst.sortKey }
          : { kind: 'expanded' },
        machine,
      });
      x += size.width + gap;
    }
    y -= gap;
  }

  // Rewrite depot-sourced lines is the router's job (it reads
  // placements); the network itself is immutable — return placements
  // with depot node ids discoverable via `source.kind === 'depot'`.
  return { version: 1, seed, placements, width, height };
}

/** Fill orientationOf: 0 or 180 for N/S-band machines, else 0. */
function fillOrientations(
  orientationOf: Map<string, Orientation>,
  rows: RowItem[][],
  network: PlannerNetwork,
): void {
  // Row x-centers are unknown until geometry runs; approximate with
  // order within the row (BFD order is placement order). For the 180°
  // question only the *vertical* relationship matters: consumers sit in
  // rows above (smaller y), suppliers below. A machine whose outputs
  // mostly flow upward wants its output band on north; inputs from
  // below want input on south.
  const rowOf = new Map<string, number>();
  rows.forEach((row, r) => {
    for (const item of row) rowOf.set(item.nodeId, r);
  });
  // Depot row is rows[0] when present; its nodes' bands are ports, not
  // edge bands — leave them at 0.
  const byId = new Map(rows.flatMap((r) => r.map((i) => [i.nodeId, i] as const)));
  for (const [nodeId, item] of byId) {
    if (nodeId.startsWith('node-depot-')) {
      orientationOf.set(nodeId, 0);
      continue;
    }
    const bands = item.type.edgeBands ?? {};
    const keys = Object.keys(bands);
    // Only N/S-only machines benefit from the half-turn question.
    const nsOnly = keys.length > 0 && keys.every((k) => k === 'north' || k === 'south');
    if (!nsOnly) {
      orientationOf.set(nodeId, 0);
      continue;
    }
    const myRow = rowOf.get(nodeId) ?? 0;
    let upFlow = 0;
    let downFlow = 0;
    for (const line of network.lines) {
      const otherRow = line.toNodeId === nodeId
        ? rowOf.get(line.fromNodeId ?? '') ?? myRow
        : line.fromNodeId === nodeId
          ? rowOf.get(line.toNodeId) ?? myRow
          : null;
      if (otherRow === null) continue;
      if (otherRow < myRow) upFlow += line.perMin;
      else if (otherRow > myRow) downFlow += line.perMin;
    }
    // At 0°, north band is output-ward for transmuters (output north,
    // input south). Consumers sit above (smaller row index). If net flow
    // goes downward instead, flip.
    const northIsOutput = bands['north']?.type === 'output';
    const wantOutputUp = upFlow >= downFlow;
    orientationOf.set(nodeId, northIsOutput === wantOutputUp ? 0 : 180);
  }
}
