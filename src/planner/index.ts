import { ALL_MACHINE_TYPES } from '../data/index.ts';
import { selectProduction } from './select.ts';
import { expandPlan } from './expand.ts';
import { layoutNetwork } from './layout.ts';
import { routePlan } from './route.ts';
import { validateBuild } from './validate.ts';
import type {
  BuildReport,
  PlacedNetwork,
  PlannerNetwork,
  PlannerPlan,
  PlannerPolicy,
  PlannerTarget,
  RoutedNetwork,
} from './types.ts';

export { selectProduction } from './select.ts';
export { expandPlan } from './expand.ts';
export { layoutNetwork, layoutPlan } from './layout.ts';
export { assignPorts, routePlan } from './route.ts';
export { validateBuild } from './validate.ts';
export type {
  BuildReport,
  FlowLine,
  NetworkPlacement,
  PlacedNetwork,
  PlanNode,
  PlannerDiagnostic,
  PlannerEdge,
  PlannerPlan,
  PlannerPolicy,
  PlannerStep,
  PlannerTarget,
  PortAssignment,
  RoutedNetwork,
  StepReport,
} from './types.ts';
export type {
  MachineType,
  Orientation,
  Recipe,
} from '../types.ts';

export interface BuiltPlan {
  plan: PlannerPlan;
  network: PlannerNetwork;
  placed: PlacedNetwork;
  routed: RoutedNetwork;
  report: BuildReport;
  /** Width × height of the placed grid. */
  width: number;
  height: number;
}

/** One pure pass: target + policy → Plan → Network → Placed → Routed → Report. */
export function buildPlan(
  target: PlannerTarget,
  policy: PlannerPolicy = {},
  machineTypes = ALL_MACHINE_TYPES,
): BuiltPlan | { error: string } {
  const seed = policy.seed ?? 0;
  const rawPlan = selectProduction(target, policy, machineTypes);
  const network = expandPlan(rawPlan, seed);
  const placed = layoutNetwork(network, rawPlan, machineTypes, { seed });
  if ('error' in placed) return placed;
  const routed = routePlan(placed, network, { seed });
  const report = validateBuild(placed, network, routed, rawPlan, seed);
  return { plan: rawPlan, network, placed, routed, report, width: placed.width, height: placed.height };
}
