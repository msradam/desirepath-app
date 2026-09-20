// Thermal routing arguments, passed through to the WASM cost rule tree.
//
// These are runtime args on every shipped profile, not a separate profile.
// Heat sensitivity moves the four thresholds; it does not multiply the profile
// list. See config/condition-map.yaml for the vocabulary that sets them, and
// router/examples/profile-*.json for the multiplier bands they gate.

export type ThermalArgs = {
  /** Off reproduces the pre-thermal router exactly. */
  heat_aware: boolean;
  /** Mean radiant temperature in degrees C above which an edge starts costing more. */
  mrt_warm?: number;
  mrt_hot?: number;
  mrt_severe?: number;
  mrt_extreme?: number;
};

export const THERMAL_OFF: ThermalArgs = { heat_aware: false };
export const THERMAL_ON: ThermalArgs = { heat_aware: true };

/** Serialise for the WASM `args_json` parameter. Null when there is nothing to say. */
export function thermalArgsJSON(t: ThermalArgs | undefined): string | null {
  if (!t || !t.heat_aware) return null;
  return JSON.stringify(t);
}

/**
 * Mean and peak MRT along a routed path, weighted by edge length.
 *
 * Unsurveyed edges are excluded rather than counted as cool, and the share of
 * the route that carried data is reported alongside, so a route that is 90%
 * outside a surveyed neighbourhood cannot masquerade as a cool one.
 */
export function routeThermalStats(
  edges: Array<{ mrt?: unknown; length?: unknown }>,
): { mean_mrt_c: number | null; max_mrt_c: number | null; surveyed_share: number } {
  let weighted = 0;
  let surveyed = 0;
  let total = 0;
  let peak = -Infinity;

  for (const e of edges) {
    const len = typeof e.length === 'number' ? e.length : 0;
    total += len;
    if (typeof e.mrt !== 'number') continue;
    weighted += e.mrt * len;
    surveyed += len;
    if (e.mrt > peak) peak = e.mrt;
  }

  return {
    mean_mrt_c: surveyed > 0 ? weighted / surveyed : null,
    max_mrt_c: Number.isFinite(peak) ? peak : null,
    surveyed_share: total > 0 ? surveyed / total : 0,
  };
}
