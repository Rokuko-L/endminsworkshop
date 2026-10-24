import { solveFlow } from '../flow.ts';
import type { EditorState } from '../layout.ts';
import type { BuildReport, PlacedNetwork, PlannerNetwork, RoutedNetwork, StepReport } from './types.ts';

/**
 * Validate a routed network: solve flow on the placed machines +
 * routed connections, then map per-machine efficiency back to plan
 * steps. Pure — builds the EditorState the solver needs, no DOM.
 */
export function validateBuild(
  placed: PlacedNetwork,
  network: PlannerNetwork,
  routed: RoutedNetwork,
  plan: { steps: { id: string; machine: string; recipeId: string; count: number }[] },
  seed = routed.seed,
): BuildReport {
  const depotAssignments: EditorState['depotAssignments'] = {};
  // Depot nodes emit their resource: assign from the lines they source.
  const depotResource = new Map<string, { resource: string; kind: 'item' | 'fluid' }>();
  for (const line of network.lines) {
    const src = line.fromNodeId ?? depotNodeForLine(line, placed);
    if (src === null) continue;
    const targetPlacement = placed.placements.find((x) => x.nodeId === src);
    if (targetPlacement !== undefined && targetPlacement.source !== null && targetPlacement.source.kind === 'depot') {
      depotResource.set(src, { resource: line.resource, kind: line.kind });
    }
  }
  for (const [nodeId, spec] of depotResource) {
    const foundPlace = placed.placements.find((x) => x.nodeId === nodeId);
    if (!foundPlace) continue;
    depotAssignments[foundPlace.machine.id] = { resource: spec.resource, kind: spec.kind, rate: 9999 };
  }

  const state: EditorState = {
    machineTypes: placed.placements.map((p) => p.machine.type),
    machines: placed.placements.map((p) => p.machine),
    connections: routed.connections,
    selectedIndex: 0,
    orientation: 0,
    mode: 'place',
    hover: null,
    invalidFlash: null,
    draftSource: null,
    draftAdjacent: null,
    draftPath: null,
    depotAssignments,
    powerPreviewId: null,
  };
  const report = solveFlow(state);
  const effByMachine = new Map(report.machines.map((m) => [m.machineId, m.efficiency]));

  const nodeStep = new Map(network.nodes.map((n) => [n.id, n.stepId]));
  // Depot placements have no network node — map machine id directly.
  const stepOfMachine = new Map<string, string>();
  for (const p of placed.placements) {
    const stepId = nodeStep.get(p.nodeId) ?? (p.source !== null && p.source.kind === 'depot' ? `depot:${p.nodeId}` : p.stepId);
    stepOfMachine.set(p.machine.id, stepId);
  }
  void stepOfMachine;

  const steps: StepReport[] = plan.steps.map((step) => {
    const perNode = placed.placements
      .filter((p) => p.stepId === step.id)
      .map((p) => ({
        nodeId: p.nodeId,
        efficiency: effByMachine.get(p.machine.id) ?? 0,
      }));
    const efficiency = perNode.length === 0
      ? 1
      : perNode.reduce((a, n) => a + n.efficiency, 0) / perNode.length;
    return {
      stepId: step.id,
      machine: step.machine,
      recipeId: step.recipeId,
      count: step.count,
      efficiency: Math.round(efficiency * 1000) / 1000,
      perNode,
    };
  });

  return {
    version: 1,
    seed,
    steps,
    warnings: report.warnings.map((w) => ({ kind: w.kind, subjectId: w.subjectId, message: w.message })),
  };
}

/** Node id sourcing a depot line: explicit node or synthesized depot. */
function depotNodeForLine(
  line: { fromNodeId: string | null; resource: string },
  placed: PlacedNetwork,
): string | null {
  if (line.fromNodeId !== null) return line.fromNodeId;
  const depot = placed.placements.find(
    (p) => p.source !== null && p.source.kind === 'depot' && p.source.input === line.resource,
  );
  return depot ? depot.nodeId : null;
}
