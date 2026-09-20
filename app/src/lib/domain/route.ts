export type WasmEdge = {
  geom: { type: 'LineString'; coordinates: [number, number][] };
  footway?: string;
  name?: string;
  incline?: number;
  crossing?: string;
  tactile_paving?: string;
  surface?: string;
  [key: string]: unknown;
};

export type RouteStep = {
  instruction: string;
  distance_m: number;
  maneuver:
    | 'depart' | 'straight' | 'slight_left' | 'slight_right'
    | 'left' | 'right' | 'sharp_left' | 'sharp_right'
    | 'uturn' | 'cross' | 'stairs' | 'elevator' | 'transit' | 'arrive';
  accessibility_note?: string;
};

import type { FeatureCollection, LineString, Feature } from 'geojson';

export type IsoEdgeProps = { time_min: number };
export type IsochroneFC = FeatureCollection<LineString, IsoEdgeProps>;
// Re-export for isochrone.ts
export type { Feature, LineString };

export type ReachableNode = { lng: number; lat: number; cost_m: number };

export type IsochroneResult = {
  edges: IsochroneFC;
  reachableNodes: ReachableNode[];
};

export type MultimodalLeg =
  | {
      kind: 'walk';
      coords: [number, number][];
      length_m: number;
      cost: number;
      from: string;
      to: string;
      edges: WasmEdge[];
    }
  | {
      kind: 'transit';
      from: string;
      to: string;
      route_short_name?: string;
      departure_min?: number;
      arrival_min?: number;
      coords: [number, number][];
    };

export type ToolError = { ok: false; error: string };

export type ReachablePoi = {
  name: string;
  resource_types: string[];
  address: string;
  lat: number;
  lng: number;
  walk_min: number;
};

export type ComfortRouteOk = {
  ok: true;
  origin_name: string;
  destination_name: string;
  destination_source: string;
  destination_address: string;
  destination_types: string[];
  destination_hours_today: unknown;
  candidates_considered: number;
  candidates_top: Array<{ name: string; source: string; lat: number; lng: number; dist_m: number }>;
  profile: string;
  night: boolean;
  length_m: number;
  cost: number;
  nodes: number;
  coords: [number, number][];
  elapsed_ms: number;
  mode?: 'walk_only' | 'walk_transit_walk';
  transit_minutes?: number;
  walking_meters?: number;
  total_seconds?: number;
  picked_stops?: { board: string; alight: string };
  /**
   * The decision metric when heat awareness is on: seconds weighted by the
   * radiant environment they are spent in. Always compare thermal_seconds with
   * thermal_seconds. `total_seconds` stays in real seconds and is what the user
   * is shown.
   */
  thermal_seconds?: number;
  /** How the transit wait was priced, and on what evidence. */
  wait?: {
    minutes: number;
    /** True when the real wait was longer than the modelling cap. */
    truncated: boolean;
    platform_mrt_c: number | null;
    platform_structure: string | null;
    underground: boolean | null;
    thermal_load: number;
    /** proxy | assumed | unsurveyed | unmodelled. See domain/thermal.ts. */
    tier: string;
  };
  multimodal_legs?: MultimodalLeg[];
  transit_warning?: string;
  sheds_on_route: [];
  shed_edge_hits: 0;
};

export type ReachableRouteOk = {
  ok: true;
  origin_name: string;
  profile: string;
  max_minutes: number;
  resource_types: string[];
  pois: ReachablePoi[];
  isochrone: IsochroneResult | null;
};
