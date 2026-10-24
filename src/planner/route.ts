import { Grid } from '../grid.ts';
import { completeDraft } from '../connections.ts';
import { allPortCells } from '../ports.ts';
import type { Connection, MachineInstance } from '../types.ts';
import type { PickedPort, PortCell } from '../layout.ts';
import type {
  FlowLine,
  PlacedNetwork,
  PlannerDiagnostic,
  PlannerNetwork,
  PortAssignment,
  RoutedNetwork,
} from './types.ts';

/**
 * Route a placed network's lines into physical connections, reusing the
 * editor's own connection pipeline (completeDraft): kind/resource
 * validation, one-connection-per-tile, perpendicular-only crossings, A*
 * with crossing cost.
 *
 * Two phases, both order-deterministic:
 *
 * - `assignPorts` (pure, no A*, parallelizable): each FlowLine gets a
 *   source/target band cell, rotating through the distance-sorted cells
 *   so parallel lines don't fight over the same start tile.
 * - `routeLines`: criticality-ordered (bigger rate first, then shorter
 *   span) A* via completeDraft on a scratch Grid clone — the input
 *   placement is never mutated, so re-route is idempotent and two
 *   orderings can be diffed.
 */

export interface RouteOpts {
  seed?: number;
  /** Re-route failed lines once after clearing to a wider corridor. */
  retryWithGap?: boolean;
}

interface ResolvedLine extends FlowLine {
  fromMachine: MachineInstance;
  toMachine: MachineInstance;
  fromPort: PortCell;
  toPort: PortCell;
}

export function assignPorts(
  placed: PlacedNetwork,
  network: PlannerNetwork,
): { assignments: PortAssignment[]; diagnostics: PlannerDiagnostic[] } {
  const byNode = new Map(placed.placements.map((p) => [p.nodeId, p]));
  const portsByMachine = new Map<string, PortCell[]>();
  for (const p of placed.placements) {
    portsByMachine.set(p.machine.id, allPortCells([p.machine]));
  }
  const assignments: PortAssignment[] = [];
  const diagnostics: PlannerDiagnostic[] = [];
  const useCount = new Map<string, number>();

  for (const line of network.lines) {
    const fromId = line.fromNodeId ?? depotSourceFor(line, placed);
    const to = byNode.get(line.toNodeId);
    const from = fromId === null ? undefined : byNode.get(fromId);
    if (!from || !to) {
      diagnostics.push({
        code: 'no-producer',
        resource: line.resource,
        perMin: line.perMin,
        message: `${line.id} (${line.resource}): no placed ${!from ? 'source' : 'consumer'} — line unassigned.`,
      });
      continue;
    }
    const fromCells = portsByMachine.get(from.machine.id) ?? [];
    const toCells = portsByMachine.get(to.machine.id) ?? [];
    const attempt = useCount.get(line.edgeId) ?? 0;
    useCount.set(line.edgeId, attempt + 1);
    const srcPort = pickPort(fromCells, 'output', line.kind, to.machine, attempt);
    const tgtPort = pickPort(toCells, 'input', line.kind, from.machine, attempt);
    if (!srcPort || !tgtPort) {
      diagnostics.push({
        code: 'no-producer',
        resource: line.resource,
        perMin: line.perMin,
        message: `${line.id} (${line.resource}): no compatible ${line.kind} band on ${!srcPort ? from.machine.type.name : to.machine.type.name}.`,
      });
      continue;
    }
    assignments.push({
      lineId: line.id,
      fromMachineId: from.machine.id,
      toMachineId: to.machine.id,
      fromPortId: portIdAt(srcPort, attempt),
      toPortId: portIdAt(tgtPort, attempt),
    });
  }
  return { assignments, diagnostics };
}

/** Depot-sourced lines read their synthesized depot placement. */
function depotSourceFor(
  line: FlowLine,
  placed: PlacedNetwork,
): string | null {
  if (line.fromNodeId !== null) return line.fromNodeId;
  const depot = placed.placements.find(
    (p) => p.source !== null && p.source.kind === 'depot' && p.source.input === line.resource,
  );
  return depot ? depot.nodeId : null;
}

export function routePlan(
  placed: PlacedNetwork,
  network: PlannerNetwork,
  opts: RouteOpts = {},
): RoutedNetwork {
  const seed = opts.seed ?? placed.seed ?? network.seed ?? 0;
  const grid = gridFromPlaced(placed);
  const byNode = new Map(placed.placements.map((p) => [p.nodeId, p]));
  const portsByMachine = new Map<string, PortCell[]>();
  for (const p of placed.placements) {
    portsByMachine.set(p.machine.id, allPortCells([p.machine]));
  }

  // Resolve lines to concrete port cells (same rotation rule as
  // assignPorts so the two phases agree).
  const useCount = new Map<string, number>();
  const resolved: ResolvedLine[] = [];
  const diagnostics: PlannerDiagnostic[] = [];
  for (const line of network.lines) {
    const fromId = line.fromNodeId ?? depotSourceFor(line, placed);
    const to = byNode.get(line.toNodeId);
    const from = fromId === null ? undefined : byNode.get(fromId);
    if (!from || !to) {
      diagnostics.push({
        code: 'no-producer',
        resource: line.resource,
        perMin: line.perMin,
        message: `${line.id} (${line.resource}): no placed ${!from ? 'source' : 'consumer'} — line skipped.`,
      });
      continue;
    }
    const attempt = useCount.get(line.edgeId) ?? 0;
    useCount.set(line.edgeId, attempt + 1);
    const srcPort = pickPort(portsByMachine.get(from.machine.id) ?? [], 'output', line.kind, to.machine, attempt);
    const tgtPort = pickPort(portsByMachine.get(to.machine.id) ?? [], 'input', line.kind, from.machine, attempt);
    if (!srcPort || !tgtPort) {
      diagnostics.push({
        code: 'no-producer',
        resource: line.resource,
        perMin: line.perMin,
        message: `${line.id} (${line.resource}): no compatible ${line.kind} band.`,
      });
      continue;
    }
    resolved.push({ ...line, fromMachine: from.machine, toMachine: to.machine, fromPort: srcPort, toPort: tgtPort });
  }

  // Criticality order: bigger rate first, then shorter port span —
  // trunk lines claim their corridor before branches.
  const span = (r: ResolvedLine): number => {
    const a = r.fromPort.cell;
    const b = r.toPort.cell;
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  };
  resolved.sort((a, b) => b.perMin - a.perMin || span(a) - span(b));

  const connections: Connection[] = [];
  const assignments: PortAssignment[] = [];
  const failed: ResolvedLine[] = [];
  for (const line of resolved) {
    const result = completeDraft(grid, toPicked(line.fromPort), line.toPort, connections, line.resource);
    if ('error' in result) {
      failed.push(line);
      continue;
    }
    grid.placeConnectionTiles(result.connection.id, result.connection.path);
    connections.push(result.connection);
    assignments.push({
      lineId: line.id,
      fromMachineId: line.fromMachine.id,
      toMachineId: line.toMachine.id,
      fromPortId: result.connection.fromPortId,
      toPortId: result.connection.toPortId,
    });
  }

  // One rip-up pass: re-route failures against the final grid (same
  // order) — catches lines blocked only by a later-routed neighbor.
  for (const line of failed.splice(0)) {
    const result = completeDraft(grid, toPicked(line.fromPort), line.toPort, connections, line.resource);
    if ('error' in result) {
      diagnostics.push({
        code: 'no-producer',
        resource: line.resource,
        perMin: line.perMin,
        message: `${line.id} (${line.resource}): ${result.error}`,
      });
      continue;
    }
    grid.placeConnectionTiles(result.connection.id, result.connection.path);
    connections.push(result.connection);
    assignments.push({
      lineId: line.id,
      fromMachineId: line.fromMachine.id,
      toMachineId: line.toMachine.id,
      fromPortId: result.connection.fromPortId,
      toPortId: result.connection.toPortId,
    });
  }

  return { version: 1, seed, connections, assignments, diagnostics };
}

/** Rebuild a routing scratch grid from placements (never the live one). */
function gridFromPlaced(placed: PlacedNetwork): Grid {
  const grid = new Grid(placed.width, placed.height);
  for (const p of placed.placements) grid.placeMachine(p.machine);
  return grid;
}

/** Pick a band cell of `type`/`kind` near the other machine; `offset`
 *  rotates through the distance-sorted cells for parallel lines. */
function pickPort(
  cells: PortCell[],
  type: 'input' | 'output',
  kind: 'item' | 'fluid',
  other: { x: number; y: number; type: { width: number; height: number } },
  offset = 0,
): PortCell | null {
  const candidates = cells.filter((c) => c.type === type && c.kind === kind);
  if (candidates.length === 0) return null;
  const ox = other.x + other.type.width / 2;
  const oy = other.y + other.type.height / 2;
  candidates.sort((a, b) => {
    const da = (a.cell.x - ox) ** 2 + (a.cell.y - oy) ** 2;
    const db = (b.cell.x - ox) ** 2 + (b.cell.y - oy) ** 2;
    return da - db;
  });
  return candidates[offset % candidates.length] ?? null;
}

function portIdAt(cell: PortCell, attempt: number): string {
  if (!cell.portId.startsWith('band:')) return cell.portId;
  const cells = cell.adjacentTiles.length;
  if (cells === 0) return cell.portId;
  return `${cell.portId}:${attempt % cells}`;
}

function toPicked(cell: PortCell): PickedPort {
  return {
    machine: cell.machine,
    side: cell.side,
    cellIndex: cell.cellIndex,
    type: cell.type,
    kind: cell.kind,
    resource: cell.resource,
    portId: cell.portId,
    adjacentTiles: cell.adjacentTiles,
  };
}
