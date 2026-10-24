import { saveDepotAssignments } from '../depot.ts';
import { nextId } from '../ids.ts';
import type { MachineInstance } from '../types.ts';
import { grid, state, ORIENTATIONS, selectedType } from './state.ts';
import { setStatus } from './status.ts';
import { redraw } from './redraw.ts';
import { groupByCategory } from '../machineEditor/grouping.ts';

export function updateOrientationLabel(): void {
  const el = document.querySelector<HTMLElement>('#orientation-label')!;
  el.textContent = `${state.orientation}°`;
}

export function rotate(): void {
  const idx = ORIENTATIONS.indexOf(state.orientation);
  state.orientation = ORIENTATIONS[(idx + 1) % ORIENTATIONS.length]!;
  updateOrientationLabel();
  redraw();
}

export function placeMachine(x: number, y: number): void {
  placeMachineAt(x, y);
}

/**
 * Place the selected type at (x, y), returning the new machine or null
 * when the footprint is blocked. `placeMachine` wraps this with the
 * status/redraw/error-flash behavior the click path needs; headless
 * callers (agent buildPlan) use the return value directly.
 */
export function placeMachineAt(x: number, y: number): MachineInstance | null {
  const type = selectedType();
  const isRot = state.orientation === 90 || state.orientation === 270;
  const effW = isRot ? type.height : type.width;
  const effH = isRot ? type.width : type.height;
  if (!grid.canPlaceWithOrientation(type, x, y, state.orientation)) {
    setStatus(`Invalid placement! '${type.name}' overlaps or is out of bounds.`, true);
    state.invalidFlash = { x, y, w: effW, h: effH };
    redraw();
    setTimeout(() => {
      state.invalidFlash = null;
      redraw();
    }, 350);
    return null;
  }
  const machine: MachineInstance = {
    id: nextId('machine'),
    type,
    x,
    y,
    orientation: state.orientation,
  };
  grid.placeMachine(machine);
  state.machines.push(machine);
  setStatus(`Placed ${type.name} at (${x}, ${y}) ${state.orientation}°.`);
  redraw();
  return machine;
}

/**
 * Re-key a placed machine (grid occupancy + state + connections +
 * depot assignment) so a headless build can use plan-stable node ids.
 */
export function renameMachine(oldId: string, newId: string): boolean {
  const machine = state.machines.find((m) => m.id === oldId);
  if (!machine) return false;
  if (state.machines.some((m) => m.id === newId)) return false;
  grid.removeMachine(oldId);
  machine.id = newId;
  grid.placeMachine(machine);
  for (const c of state.connections) {
    if (c.fromMachineId === oldId) c.fromMachineId = newId;
    if (c.toMachineId === oldId) c.toMachineId = newId;
  }
  if (state.depotAssignments[oldId]) {
    state.depotAssignments[newId] = state.depotAssignments[oldId]!;
    delete state.depotAssignments[oldId];
    saveDepotAssignments(state.depotAssignments);
  }
  return true;
}

export function removeMachineAt(x: number, y: number): void {
  const id = grid.getOccupancyAt(x, y);
  if (!id) return;
  if (state.depotAssignments[id]) {
    delete state.depotAssignments[id];
    saveDepotAssignments(state.depotAssignments);
  }
  for (const c of [...state.connections]) {
    if (c.fromMachineId === id || c.toMachineId === id) {
      grid.removeConnection(c.id);
    }
  }
  state.connections = state.connections.filter(
    (c) => c.fromMachineId !== id && c.toMachineId !== id,
  );
  grid.removeMachine(id);
  state.machines = state.machines.filter((m) => m.id !== id);
  setStatus('Removed machine (and any connections referencing it).');
  redraw();
}

export function removeConnectionAt(x: number, y: number): void {
  const id = grid.getConnectionAt(x, y);
  if (!id) return;
  grid.removeConnection(id);
  state.connections = state.connections.filter((c) => c.id !== id);
  setStatus('Removed connection.');
  redraw();
}

export function clearAll(): void {
  for (const m of state.machines) grid.removeMachine(m.id);
  for (const c of state.connections) grid.removeConnection(c.id);
  state.machines = [];
  state.connections = [];
  state.hover = null;
  state.draftSource = null;
  state.draftAdjacent = null;
  state.draftPath = null;
  state.depotAssignments = {};
  saveDepotAssignments(state.depotAssignments);
  setStatus('Cleared layout.');
  redraw();
}

export function clearConnections(): void {
  for (const c of state.connections) grid.removeConnection(c.id);
  state.connections = [];
  state.draftSource = null;
  state.draftAdjacent = null;
  state.draftPath = null;
  setStatus('Cleared connections.');
  redraw();
}

export function populateSelector(): void {
  const select = document.querySelector<HTMLSelectElement>('#machine-select')!;
  select.innerHTML = '';
  const groups = groupByCategory(state.machineTypes);
  for (const [category, indices] of groups) {
    const group = document.createElement('optgroup');
    group.label = category;
    for (const i of indices) {
      const t = state.machineTypes[i]!;
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `${t.name}  (${t.width}×${t.height})`;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
  if (state.machineTypes.length > 0) {
    state.selectedIndex = Math.min(state.selectedIndex, state.machineTypes.length - 1);
    select.value = String(state.selectedIndex);
  } else {
    state.selectedIndex = 0;
    select.value = '0';
  }
}
