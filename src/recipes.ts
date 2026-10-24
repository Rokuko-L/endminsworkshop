import type { Connection, MachineInstance, MachineType, Recipe, ResourceKind } from './types.ts';

/**
 * Find the recipe on `target` that consumes a connection's
 * `resource+kind` as an input. Returns the matching recipe, or null
 * if no recipe matches (the connection is then a passthrough).
 *
 * Match rule: a recipe matches if the connection's resource+kind
 * appears as one of its inputs. We do not yet check input ratios
 * or the destination's other required inputs — that's a future
 * enhancement for rate-based validation.
 */
export function matchRecipe(
  target: MachineInstance,
  resource: string,
  kind: ResourceKind,
): Recipe | null {
  for (const recipe of target.type.recipes) {
    for (const input of recipe.inputs) {
      if (input.resource === resource && input.kind === kind) {
        return recipe;
      }
    }
  }
  return null;
}

/**
 * Pick the recipe that the current inbound/outbound connections imply:
 * input side — most distinct fed slots wins (machines like the
 * Packaging Unit share inputs across recipes); ties prefer fully-fed
 * recipes (a bidirectional transmuter fed only Xiragen matches both
 * Xiragen→Xiranite and Xiranite→Xiragen — fully-fed wins).
 * Output side — recipes whose outputs match outbound resources outrank
 * the rest (a source machine with no inbound, like the Gas Extractor
 * wired for Xiragen, must not fall back to Inergen).
 */
export function selectBestRecipe(
  type: MachineType,
  inbound: Connection[],
  outbound: Connection[] = [],
): Recipe | null {
  const outboundResources = new Set(
    outbound.filter((c) => c.resource.trim() !== '').map((c) => c.resource),
  );
  let best: Recipe | null = null;
  let bestOut = -1;
  let bestFed = -1;
  let bestFullyFed = false;
  for (const recipe of type.recipes) {
    if (recipe.inputs.length === 0 && recipe.outputs.length === 0) continue;
    const fed = recipe.inputs.filter((slot) =>
      inbound.some((c) => c.resource === slot.resource && c.kind === slot.kind),
    ).length;
    const fullyFed = recipe.inputs.length > 0 && fed === recipe.inputs.length;
    const out = [...outboundResources].filter((r) =>
      recipe.outputs.some((o) => o.resource === r),
    ).length;
    if (
      out > bestOut ||
      (out === bestOut && fed > bestFed) ||
      (out === bestOut && fed === bestFed && fullyFed && !bestFullyFed)
    ) {
      best = recipe;
      bestOut = out;
      bestFed = fed;
      bestFullyFed = fullyFed;
    }
  }
  return best;
}

/**
 * Walk all connections, look up each destination's recipe, and
 * populate `matchedRecipeId` if not already set. Returns the new
 * array. Connections whose destination machine no longer exists
 * (e.g. it was removed) are left as-is with `matchedRecipeId: null`.
 */
export function reconcileConnectionRecipes(
  connections: Connection[],
  machines: MachineInstance[],
): Connection[] {
  const byId = new Map<string, MachineInstance>();
  for (const m of machines) byId.set(m.id, m);
  return connections.map((c) => {
    if (c.matchedRecipeId !== null) return c;
    const target = byId.get(c.toMachineId);
    if (!target) return c;
    const recipe = matchRecipe(target, c.resource, c.kind);
    return { ...c, matchedRecipeId: recipe ? recipe.id : null };
  });
}