import { maxThroughput } from '../logistics.ts';
import type { FlowLine, PlannerNetwork, PlannerPlan, PlanNode } from './types.ts';

/**
 * Expand a Plan (aggregated steps + edges) into a Network: one PlanNode
 * per physical machine, one FlowLine per routable line. Pure.
 *
 * - Nodes follow the step's `loadPerMachine` — fill-first, so the last
 *   machine absorbs the ceil remainder (e.g. 2 extractors for 30/min
 *   Xiragen → loads [1, 0.5]).
 * - Edge rates split across source nodes proportional to load, and a
 *   line never exceeds the transport capacity for its kind (belts 30,
 *   pipes 120) — oversized edges fan out into parallel lines against
 *   round-robin target nodes.
 * - Depot-sourced edges (`from: null`) fan out against their consumers
 *   with `fromNodeId: null`; layout places depot nodes for them.
 */

export function expandPlan(plan: PlannerPlan, seed = plan.seed): PlannerNetwork {
  const nodes: PlanNode[] = [];
  const nodesByStep = new Map<string, PlanNode[]>();
  for (const step of plan.steps) {
    const list: PlanNode[] = [];
    for (let i = 0; i < step.count; i++) {
      const node: PlanNode = {
        id: `node-${nodes.length}`,
        stepId: step.id,
        machine: step.machine,
        recipeId: step.recipeId,
        index: i,
        load: step.loadPerMachine[i] ?? 1,
      };
      nodes.push(node);
      list.push(node);
    }
    nodesByStep.set(step.id, list);
  }

  const lines: FlowLine[] = [];
  for (const edge of plan.edges) {
    const targets = nodesByStep.get(edge.toStepId) ?? [];
    if (targets.length === 0) continue;
    const sources = edge.fromStepId === null ? [] : (nodesByStep.get(edge.fromStepId) ?? []);
    const capacity = maxThroughput(edge.kind);
    // Demand share per target node: even split — the consuming recipe
    // draws the same slot rate on every machine.
    const perTarget = edge.perMin / targets.length;
    const linesPerTarget = Math.max(1, Math.ceil(perTarget / capacity - 1e-9));
    const perLine = perTarget / linesPerTarget;
    // Fill-first source order: fuller machines serve first. Weighted by
    // load so a load-0.5 machine serves half as many lines.
    const serving = weightedOrder(sources);
    let si = 0;
    for (const target of targets) {
      for (let k = 0; k < linesPerTarget; k++) {
        const fromNodeId = serving.length > 0 ? serving[si % serving.length]!.id : null;
        si++;
        lines.push({
          id: `line-${lines.length}`,
          edgeId: edge.id,
          fromNodeId,
          toNodeId: target.id,
          resource: edge.resource,
          kind: edge.kind,
          perMin: Math.round(perLine * 10) / 10,
        });
      }
    }
  }

  return { version: 1, seed, nodes, lines };
}

/**
 * Deterministic source order, fuller machines first, partial-load
 * machines appearing proportionally less often: loads [1, 0.5] serve
 * as [node-0, node-0, node-1] repeating, so line counts follow supply.
 */
function weightedOrder(sources: PlanNode[]): PlanNode[] {
  const ordered = [...sources].sort((a, b) => b.load - a.load || a.index - b.index);
  const order: PlanNode[] = [];
  const slots = 4;
  for (const n of ordered) {
    const times = Math.max(1, Math.round(n.load * slots));
    for (let i = 0; i < times; i++) order.push(n);
  }
  return order;
}
