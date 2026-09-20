// Isochrone computation from WASM shortest-path tree. Pure function, no DOM.

import type { Feature, LineString } from 'geojson';
import type { IsochroneResult } from './domain/route';
import type { ThermalArgs } from './domain/thermal';
import { thermalArgsJSON } from './domain/thermal';

const WALK_MPS = 1.25;

type WasmIsoRouter = {
  shortestPathTreeJSON(profile: string, lat: number, lng: number, maxCost: number, args: string | null): string;
};

export function computeIsochrone(
  wasm: WasmIsoRouter,
  profile: string,
  lat: number,
  lng: number,
  maxMinutes = 15,
  thermal?: ThermalArgs
): IsochroneResult | null {
  // The budget is in metre-equivalent cost units, not metres. With heat_aware
  // on, a minute of budget buys less ground on an exposed street than on a
  // shaded one, which is the whole point. Real walking time is still derived
  // from edge length, never from this cost.
  const maxCost = maxMinutes * 60 * WALK_MPS;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(
      wasm.shortestPathTreeJSON(profile, lat, lng, maxCost, thermalArgsJSON(thermal))
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.status !== 'Ok') return null;

  const nc = raw.node_costs as {
    features: Array<{
      geometry: { coordinates: [number, number] };
      properties: { _id: string; cost: number };
    }>;
  };

  const nodeCosts = new Map<string, number>();
  const reachableNodes = [];
  for (const f of nc.features) {
    nodeCosts.set(f.properties._id, f.properties.cost);
    reachableNodes.push({
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      cost_m: f.properties.cost,
    });
  }

  const features: Feature<LineString, { time_min: number }>[] = [];
  const edgesFC = raw.edges as {
    features: Array<Feature<LineString, { _u: string; _v: string }>>;
  };
  for (const f of edgesFC.features) {
    const vCost = nodeCosts.get(f.properties._v) ?? 0;
    const time_min = vCost / WALK_MPS / 60;
    if (time_min > maxMinutes) continue;
    features.push({ type: 'Feature', geometry: f.geometry, properties: { time_min } });
  }

  return { edges: { type: 'FeatureCollection', features }, reachableNodes };
}
