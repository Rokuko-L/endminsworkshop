import type { Connection, MachineInstance, ResourceKind } from '../types.ts';

/**
 * Planner artifacts: five JSON-serializable stages with stable IDs.
 *
 *   target + policy → Plan (what to build, aggregated)
 *   Plan → Network (which node feeds which node, per-line rates)
 *   Network → Placed (nodes + x/y/orientation)
 *   Placed + Network → Routed (physical connections)
 *   Routed → Report (flow solved, mapped back to steps)
 *
 * Every artifact carries `version` + `seed` so golden tests are stable
 * and a stage can be re-run without re-running the world. IDs are
 * stable (`step-0`, `node-3`, `line-7`, `edge-0`) — editing JSON and
 * resuming downstream is the supported playground flow.
 */

export interface PlannerPolicy {
  /** Raw resources provided from depots/conduits, per-minute. */
  available?: Record<string, number>;
  /** Machine type names the planner must not use. */
  ban?: string[];
  /** Preferred machine type names, in order — tie-break only. */
  prefer?: string[];
  /** Reserved for Phase 4 cost weights; unused by select/expand today. */
  weights?: { power?: number; area?: number; lines?: number };
  /** Determinism seed. Recorded on artifacts; ordering is already fixed. */
  seed?: number;
}

export interface PlannerTarget {
  resource: string;
  perMin: number;
}

/** Machine-readable diagnostic; `notes` stays the human rendering. */
export interface PlannerDiagnostic {
  code:
    | 'recipe-choice'
    | 'net-cycle'
    | 'recycle-loop'
    | 'overproduce'
    | 'divergent'
    | 'raw-input'
    | 'unquantified'
    | 'no-producer';
  resource?: string;
  perMin?: number;
  message: string;
}

/** One production step: a machine type running one recipe, N times. */
export interface PlannerStep {
  /** Stable id, `step-<index>`. */
  id: string;
  /** MachineType name (unique catalog key). */
  machine: string;
  recipeId: string;
  count: number;
  /**
   * Fill-first utilization per machine, length `count`, each 0..1.
   * Machine 0..N-2 run at 1.0; the last absorbs the ceil remainder —
   * e.g. 2 Gas Extractors for 30/min Xiragen → [1, 0.5].
   */
  loadPerMachine: number[];
}

/** A required material flow between two steps (or from a depot). */
export interface PlannerEdge {
  /** Stable id, `edge-<index>`. */
  id: string;
  /** Producing step index, or null when sourced from a depot/conduit. */
  from: number | null;
  to: number;
  /** Stable step ids mirroring from/to. */
  fromStepId: string | null;
  toStepId: string;
  resource: string;
  kind: ResourceKind;
  /** Total per-minute rate all lines for this edge must carry. */
  perMin: number;
}

export interface PlannerPlan {
  version: 1;
  seed: number;
  target: PlannerTarget;
  steps: PlannerStep[];
  edges: PlannerEdge[];
  /** Raw inputs the plan expects from depots/conduits. */
  inputs: { resource: string; kind: ResourceKind; perMin: number }[];
  /** Human-readable notes (rendering of diagnostics + choice notes). */
  notes: string[];
  diagnostics: PlannerDiagnostic[];
}

/** One physical machine in the network: step-`count` expanded. */
export interface PlanNode {
  /** Stable id, `node-<n>` in step order then index order. */
  id: string;
  stepId: string;
  machine: string;
  recipeId: string;
  /** Index within its step (0..count-1). */
  index: number;
  /** Fill-first utilization 0..1 — share of a full machine's net output. */
  load: number;
}

/**
 * One physical line: the routable unit. `perMin` never exceeds the
 * transport capacity for its kind (belts 30, pipes 120) — an edge whose
 * rate exceeds one line fans out into several FlowLines.
 */
export interface FlowLine {
  /** Stable id, `line-<n>`. */
  id: string;
  edgeId: string;
  fromNodeId: string | null;
  toNodeId: string;
  resource: string;
  kind: ResourceKind;
  perMin: number;
}

export interface PlannerNetwork {
  version: 1;
  seed: number;
  nodes: PlanNode[];
  lines: FlowLine[];
}

export interface NetworkPlacement {
  nodeId: string;
  stepId: string;
  /** Null for depot nodes — synthesized by layout, not expanded. */
  source: { kind: 'expanded' } | { kind: 'depot'; input: string } | null;
  machine: MachineInstance;
}

export interface PlacedNetwork {
  version: 1;
  seed: number;
  placements: NetworkPlacement[];
  width: number;
  height: number;
}

/** One line's port assignment — pure, testable without A*. */
export interface PortAssignment {
  lineId: string;
  fromMachineId: string;
  toMachineId: string;
  fromPortId: string;
  toPortId: string;
}

export interface RoutedNetwork {
  version: 1;
  seed: number;
  connections: Connection[];
  assignments: PortAssignment[];
  diagnostics: PlannerDiagnostic[];
}

export interface StepReport {
  stepId: string;
  machine: string;
  recipeId: string;
  count: number;
  /** Mean efficiency across the step's placed nodes. */
  efficiency: number;
  perNode: { nodeId: string; efficiency: number }[];
}

export interface BuildReport {
  version: 1;
  seed: number;
  steps: StepReport[];
  warnings: { kind: string; subjectId: string; message: string }[];
}
