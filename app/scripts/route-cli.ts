/**
 * route-cli. Programmatic test harness for ariadne-nyc routing.
 *
 * Boots the same RouterService used in the browser, against the same data
 * files in <repo>/data/, and runs a single query with verbose diagnostics.
 *
 * Usage:
 *   npx tsx scripts/route-cli.ts plan "Kew Gardens" "Grand Central" wheelchair
 *   npx tsx scripts/route-cli.ts find "Penn Station" cool_indoor wheelchair
 *   npx tsx scripts/route-cli.ts reach "Penn Station" cool_indoor 15
 *
 * The harness skips WebLLM entirely. Tool calls are constructed directly,
 * so this exercises the deterministic routing path without LLM nondeterminism.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Timetable, StopsIndex, Router as MinotorRouter, Query } from 'minotor';
import type { Stop, Route as MinotorRoute } from 'minotor';

import { RouterService } from '../src/lib/services/router-service.ts';
import type { ComfortFeature } from '../src/lib/domain/poi.ts';
import type { RouterProfileId } from '../src/lib/domain/profile.ts';
import { computeIsochrone } from '../src/lib/isochrone.ts';
import type { WasmEdge, IsochroneResult } from '../src/lib/domain/route.ts';
import type {
  PedestrianRouterAdapter,
  RouteResult,
} from '../src/lib/adapters/pedestrian-router.ts';
import type { TransitRouterAdapter } from '../src/lib/adapters/transit-router.ts';
import { FuseGeocoderAdapter } from '../src/lib/adapters/geocoder.ts';
import type { GeocoderAdapter } from '../src/lib/adapters/geocoder.ts';
import { resolveImpactedInternal } from '../src/lib/adapters/feed-mta-outages.ts';
import {
  thermalArgsJSON, routeThermalStats, makeStopThermalIndex,
  THERMAL_ON, THERMAL_OFF, SUN_INFLATION_DEFAULT, SUN_INFLATION_SENSITIVE,
} from '../src/lib/domain/thermal.ts';
import type { StopThermalIndex } from '../src/lib/domain/thermal.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// app/scripts/route-cli.ts → repo root is two levels up
const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(REPO_ROOT, 'data');
const PKG = path.join(REPO_ROOT, 'router/pkg');
const PROFILES_DIR = path.join(REPO_ROOT, 'router/examples');

// ── ANSI helpers ───────────────────────────────────────────────────────────
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

function log(...args: unknown[]) { console.log(...args); }

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function logSection(title: string) { log(`\n${c.bold(c.blue(`── ${title} ──`))}`); }

// ── Pedestrian (WASM) ──────────────────────────────────────────────────────
async function makePedestrianAdapter(): Promise<PedestrianRouterAdapter & { wasm: any }> {
  log(c.dim(`Loading WASM router from ${path.relative(REPO_ROOT, PKG)}…`));
  const wasmMod = await import(`file://${PKG}/unweaver_wasm.js`);
  const wasmBytes = fs.readFileSync(path.join(PKG, 'unweaver_wasm_bg.wasm'));
  await wasmMod.default({ module_or_path: wasmBytes });

  const thermalGraph = path.join(DATA, 'nyc-pedestrian-thermal.bin');
  const baseGraph = path.join(DATA, 'nyc-pedestrian.bin');
  const graphPath = fs.existsSync(thermalGraph) ? thermalGraph : baseGraph;
  if (graphPath === baseGraph) {
    log(c.yellow('  no thermal graph found; run `uv run python -m pipeline.thermal build` for MRT'));
  }
  log(c.dim(`Loading pedestrian graph from ${path.relative(REPO_ROOT, graphPath)}…`));
  const graphBytes = fs.readFileSync(graphPath);
  const wasm = wasmMod.Router.fromBinary(new Uint8Array(graphBytes));

  for (const id of ['manual_wheelchair', 'generic_pedestrian', 'low_vision'] as const) {
    const file = path.join(PROFILES_DIR, `profile-${id}.json`);
    wasm.addProfile(id, fs.readFileSync(file, 'utf8'));
  }

  log(c.dim(`Graph: ${wasm.nodeCount().toLocaleString()} nodes, ${wasm.edgeCount().toLocaleString()} edges`));

  return {
    wasm,
    ready: Promise.resolve(),
    route({ from, to, profile, thermal }) {
      const json = wasm.shortestPathJSON(profile, from[1], from[0], to[1], to[0], thermalArgsJSON(thermal));
      const res = JSON.parse(json) as { status: string; code?: string; total_cost?: number; edges?: WasmEdge[] };
      if (res.status !== 'Ok' || !res.edges) throw new Error(`No path (${res.code ?? res.status})`);
      const coords: [number, number][] = [];
      for (const e of res.edges) {
        for (const pt of e.geom.coordinates) {
          const last = coords[coords.length - 1];
          if (!last || last[0] !== pt[0] || last[1] !== pt[1]) coords.push(pt);
        }
      }
      const length_m = coords.length > 1
        ? coords.slice(1).reduce((sum, pt, i) => sum + haversineM(coords[i], pt), 0) : 0;
      return { cost: res.total_cost ?? length_m, length_m, coords, nodes: res.edges.length + 1, edges: res.edges } as RouteResult;
    },
    shortestPathTree({ from, profile, maxMinutes, thermal }): IsochroneResult | null {
      return computeIsochrone(wasm, profile, from[1], from[0], maxMinutes, thermal);
    },
    stats() { return { nodes: wasm.nodeCount(), edges: wasm.edgeCount() }; },
    getRawWasm() { return wasm; },
  };
}

// ── Geocoder (uses the real FuseGeocoderAdapter) ────────────────────────────
async function makeGeocoderAdapter(): Promise<GeocoderAdapter> {
  log(c.dim('Loading POI index via FuseGeocoderAdapter…'));
  // Polyfill fetch() to read POI JSON from disk so we use the real adapter unchanged.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, _init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('file://') || url.startsWith('/')) {
      const filepath = url.startsWith('file://') ? fileURLToPath(url) : path.join(DATA, path.basename(url));
      const data = await fs.promises.readFile(filepath);
      return new Response(data, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return origFetch(input as any, _init);
  }) as typeof fetch;

  const stubLog = { z1: () => {}, z2: () => {}, z3: () => {} } as any;
  const adapter = new FuseGeocoderAdapter(stubLog);
  const count = await adapter.load(`file://${path.join(DATA, 'nyc-pois.json')}`);
  log(c.dim(`POI index: ${count.toLocaleString()} entries`));
  const streetsPath = path.join(DATA, 'nyc-streets.json');
  if (fs.existsSync(streetsPath) && adapter.loadStreets) {
    const sCount = await adapter.loadStreets(`file://${streetsPath}`);
    log(c.dim(`Street index: ${sCount.toLocaleString()} (street, borough) entries`));
  }
  return adapter;
}

// ── Transit (Minotor) ──────────────────────────────────────────────────────
async function makeTransitAdapter(): Promise<TransitRouterAdapter | undefined> {
  log(c.dim('Loading Minotor transit data…'));
  const ttBuf = fs.readFileSync(path.join(DATA, 'timetable.bin'));
  const stopsBuf = fs.readFileSync(path.join(DATA, 'stops.bin'));
  const adaArr = JSON.parse(fs.readFileSync(path.join(DATA, 'ada-stops.json'), 'utf8')) as string[];

  const timetable = Timetable.fromData(new Uint8Array(ttBuf));
  const stops = StopsIndex.fromData(new Uint8Array(stopsBuf));
  const router = new MinotorRouter(timetable, stops);

  const adaInternalIds = new Set<number>();
  const adaSourceStopIds = new Set<string>(adaArr);
  for (const sid of adaArr) {
    const s = stops.findStopBySourceStopId(sid);
    if (!s) continue;
    const parent = (s.parent ?? s.id) as number;
    const root = stops.findStopById(parent) ?? s;
    adaInternalIds.add(root.id);
    for (const eq of stops.equivalentStops(root.id)) adaInternalIds.add(eq.id);
  }

  log(c.dim(`Transit: ${stops.size().toLocaleString()} stops · ${adaInternalIds.size} ADA`));

  return {
    stopsCount: stops.size(),
    adaInternalIds,
    adaSourceStopIds,
    stops,
    findNearestStops: (lat, lng, maxResults = 3, radiusKm = 0.8) => stops.findStopsByLocation(lat, lng, maxResults, radiusKm),
    findStopById: (id) => stops.findStopById(id),
    route: (fromStopId: number, toStopIds: Set<number>, departureMinutes: number): MinotorRoute | null => {
      const q = new Query.Builder().from(fromStopId).to(toStopIds).departureTime(departureMinutes).maxTransfers(3).build();
      const result = router.route(q);
      return result.bestRoute(toStopIds) ?? null;
    },
    subtractImpactedElevators(gtfsStopIds: Set<string>): number {
      const impacted = resolveImpactedInternal(stops, gtfsStopIds);
      for (const id of impacted) adaInternalIds.delete(id);
      return impacted.size;
    },
  };
}

// ── Platform thermal profile ───────────────────────────────────────────────
function loadStopThermal(): StopThermalIndex | null {
  const file = path.join(DATA, 'thermal-stops.json');
  if (!fs.existsSync(file)) {
    log(c.yellow('  no thermal-stops.json; transit waits priced by duration alone'));
    return null;
  }
  const index = makeStopThermalIndex(JSON.parse(fs.readFileSync(file, 'utf8')));
  log(c.dim(`Platform thermal: ${index.size} stops (underground assumed ${index.undergroundAssumptionC} C)`));
  return index;
}

// ── Comfort features ───────────────────────────────────────────────────────
function loadComfort(): ComfortFeature[] {
  log(c.dim('Loading comfort features…'));
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'nyc-comfort.json'), 'utf8'));
  const features = (raw.features ?? raw) as ComfortFeature[];
  log(c.dim(`Comfort features: ${features.length.toLocaleString()}`));
  return features;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || !['plan', 'find', 'reach', 'geocode', 'diagnose', 'thermal', 'thermal-suite', 'transit', 'transit-scan', 'coverage'].includes(cmd)) {
    console.error('Usage:');
    console.error('  npx tsx scripts/route-cli.ts plan "<from>" "<to>" [profile]');
    console.error('  npx tsx scripts/route-cli.ts find "<near>" "<resource_type>" [profile]');
    console.error('  npx tsx scripts/route-cli.ts reach "<near>" "<resource_type>" [max_minutes] [profile]');
    console.error('  npx tsx scripts/route-cli.ts geocode "<query>"');
    console.error('  npx tsx scripts/route-cli.ts thermal "<from>" "<to>" [profile] [sun_inflation]');
    console.error('  npx tsx scripts/route-cli.ts thermal-suite                        # the regression battery');
    console.error('  npx tsx scripts/route-cli.ts transit "<from>" "<to>" [profile] [sun_inflation]');
    console.error('  npx tsx scripts/route-cli.ts coverage <NTA> [sun_inflation]      # the quarter-mile claim');
    console.error('\nProfiles: generic_pedestrian | wheelchair | low_vision | slow_walker | stroller');
    console.error('Resource types: cool_indoor warm_indoor bathroom seating quiet_indoor wifi_power');
    console.error('               linknyc food_pantry senior_center harm_reduction medical mental_health');
    console.error('               community_center shelter_24h pool_indoor');
    process.exit(1);
  }

  logSection('BOOT');
  const pedestrian = await makePedestrianAdapter();
  const comfort = loadComfort();
  const geocoder = await makeGeocoderAdapter();
  const transit = await makeTransitAdapter();
  const stopThermal = loadStopThermal();
  const service = new RouterService(geocoder as any, pedestrian, transit, comfort, null, stopThermal);

  logSection(cmd.toUpperCase());

  if (cmd === 'geocode') {
    const q = rest[0];
    const r = await geocoder.geocodeAsync(q);
    log(r ? c.green('found:') : c.red('miss:'), r ?? '(none)');
    return;
  }

  if (cmd === 'diagnose') {
    const [from, to, profile = 'generic_pedestrian'] = rest;
    log(`from=${c.bold(from)}  to=${c.bold(to)}  profile=${c.bold(profile)}`);

    const a = await geocoder.geocodeAsync(from);
    const b = await geocoder.geocodeAsync(to);
    if (!a) { log(c.red('origin geocode miss')); return; }
    if (!b) { log(c.red('destination geocode miss')); return; }
    log(`origin: ${a.display} @ ${a.lat.toFixed(4)},${a.lng.toFixed(4)}`);
    log(`dest:   ${b.display} @ ${b.lat.toFixed(4)},${b.lng.toFixed(4)}`);

    const PROFILE_MAP: Record<string, RouterProfileId> = {
      wheelchair: 'manual_wheelchair', manual_wheelchair: 'manual_wheelchair',
      slow_walker: 'generic_pedestrian', stroller: 'generic_pedestrian',
      low_vision: 'low_vision', generic_pedestrian: 'generic_pedestrian',
    };
    const p = PROFILE_MAP[profile] ?? 'generic_pedestrian';
    log(`resolved profile: ${p}`);

    log(c.bold('\n[1] walk-only attempt'));
    try {
      const r = pedestrian.route({ from: [a.lng, a.lat], to: [b.lng, b.lat], profile: p, night: false });
      log(c.green(`  ok: ${r.length_m}m, ${(r.length_m / 1.4 / 60).toFixed(0)} min walk`));
    } catch (e) {
      log(c.red(`  fail: ${(e as Error).message}`));
    }

    if (!transit) { log(c.red('no transit adapter')); return; }

    const requireAda = p === 'manual_wheelchair';
    const radius = requireAda ? 4.0 : 2.0;
    log(c.bold(`\n[2] nearest stops (radius=${radius}km, requireAda=${requireAda})`));
    const originRaw = transit.findNearestStops(a.lat, a.lng, 40, radius);
    const destRaw = transit.findNearestStops(b.lat, b.lng, 40, radius);
    log(`  origin candidates raw: ${originRaw.length}`);
    log(`  dest   candidates raw: ${destRaw.length}`);

    function dedupeToParents(s: Stop[]): Stop[] {
      const seen = new Set<number>();
      const out: Stop[] = [];
      for (const x of s) {
        const id = (x.parent ?? x.id) as number;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(transit!.findStopById(id) ?? x);
      }
      return out;
    }
    const originParents = dedupeToParents(originRaw);
    const destParents = dedupeToParents(destRaw);
    log(`  origin parents: ${originParents.length} → ${originParents.slice(0, 5).map((s) => s.name).join(', ')}`);
    log(`  dest   parents: ${destParents.length} → ${destParents.slice(0, 5).map((s) => s.name).join(', ')}`);

    const filterAda = (stops: Stop[]) => {
      if (!transit!.adaInternalIds.size) return stops;
      const accessible = stops.filter((x) => transit!.adaInternalIds.has(x.id));
      return requireAda ? accessible : stops;
    };
    const originAda = filterAda(originParents).slice(0, 6);
    const destAda = filterAda(destParents).slice(0, 6);
    log(`  origin ADA-filtered: ${originAda.length} → ${originAda.map((s) => s.name).join(', ')}`);
    log(`  dest   ADA-filtered: ${destAda.length} → ${destAda.map((s) => s.name).join(', ')}`);

    if (!originAda.length || !destAda.length) {
      log(c.red('  [3] cannot try RAPTOR. Empty origin or dest stop set'));
      return;
    }

    const now = new Date();
    const depMinutes = now.getHours() * 60 + now.getMinutes();
    log(c.bold(`\n[3] RAPTOR (departureMinutes=${depMinutes})`));
    const destSet = new Set(destAda.map((s) => s.id));
    let attempts = 0, hits = 0;
    for (const orig of originAda) {
      attempts++;
      const route = transit!.route(orig.id, destSet, depMinutes);
      if (!route || !route.legs?.length) continue;
      hits++;
      const last = route.legs[route.legs.length - 1];
      const transitMin = (() => { try { return route.arrivalTime() - route.departureTime(); } catch { return -1; } })();
      log(c.green(`  ✓ from ${orig.name} → ${last.to.name} (${route.legs.length} legs, ${transitMin} min transit)`));
    }
    log(`  attempts: ${attempts}, RAPTOR hits: ${hits}`);

    if (!hits) {
      log(c.red('  RAPTOR found no transit route between any origin/dest pair'));
      return;
    }

    log(c.bold('\n[4] walk-in / walk-out feasibility for first RAPTOR hit'));
    for (const orig of originAda) {
      const route = transit!.route(orig.id, destSet, depMinutes);
      if (!route || !route.legs?.length) continue;
      const last = route.legs[route.legs.length - 1];
      const alight = last.to;
      try {
        const walkIn = pedestrian.route({ from: [a.lng, a.lat], to: [orig.lon!, orig.lat!], profile: p, night: false });
        log(c.green(`  walk-in ok: ${a.display} → ${orig.name} (${walkIn.length_m}m)`));
      } catch (e) {
        log(c.red(`  walk-in FAIL: ${a.display} → ${orig.name}: ${(e as Error).message}`));
      }
      try {
        const walkOut = pedestrian.route({ from: [alight.lon!, alight.lat!], to: [b.lng, b.lat], profile: p, night: false });
        log(c.green(`  walk-out ok: ${alight.name} → ${b.display} (${walkOut.length_m}m)`));
      } catch (e) {
        log(c.red(`  walk-out FAIL: ${alight.name} → ${b.display}: ${(e as Error).message}`));
      }
      break;
    }
    return;
  }

  if (cmd === 'coverage') {
    // Does the City's quarter-mile claim hold on the sidewalk network?
    //
    //   "ensuring no New Yorker in the most heat-burdened communities is more
    //    than 1/4 mile away from an outdoor cooling element"
    //   NYC DEP, Mayor de Blasio Expands Cool It! NYC, 24 June 2020
    //
    // "Away from" is a straight line. This measures the same budget three
    // ways: as the crow flies, along the pedestrian network, and along the
    // network with heat priced in.
    const nta = (rest[0] || 'BK1602').toUpperCase();
    const inflation = rest[1] ? Number(rest[1]) : SUN_INFLATION_SENSITIVE;
    const metaPath = path.join(DATA, 'thermal', `${nta}.json`);
    if (!fs.existsSync(metaPath)) {
      log(c.red(`no thermal grid for ${nta}. Run: uv run python -m pipeline.thermal build --nta ${nta}`));
      return;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const QM = meta.quarter_mile_m as number;

    // ── point in (multi)polygon, ray casting ────────────────────────────────
    function inRing(lng: number, lat: number, ring: number[][]): boolean {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    const polys: number[][][][] =
      meta.boundary.type === 'MultiPolygon' ? meta.boundary.coordinates : [meta.boundary.coordinates];
    function inNTA(lng: number, lat: number): boolean {
      for (const poly of polys) {
        if (!inRing(lng, lat, poly[0])) continue;
        let hole = false;
        for (let h = 1; h < poly.length; h++) if (inRing(lng, lat, poly[h])) hole = true;
        if (!hole) return true;
      }
      return false;
    }

    // ── the cooling elements ────────────────────────────────────────────────
    type Elem = { lon: number; lat: number; name: string; kind: string };
    const all: Elem[] = meta.cooling_elements;
    // An element just outside the boundary still cools people inside it, so
    // the set is everything inside the NTA plus everything within a quarter
    // mile of a walkable node inside it. That filter needs the node universe,
    // so it runs after the enumeration below.
    let near: Elem[] = all;


    // ── enumerate the walkable network inside the NTA ───────────────────────
    // A tree from the centroid with a generous budget enumerates every node
    // connected to it. Nodes that are not connected are not walkable, so the
    // connected set is the right denominator.
    let cx = 0, cy = 0, n = 0;
    for (const poly of polys) for (const [lng, lat] of poly[0]) { cx += lng; cy += lat; n++; }
    cx /= n; cy /= n;
    const wasm = (pedestrian as any).wasm;
    const enumerate = JSON.parse(
      wasm.shortestPathTreeJSON('generic_pedestrian', cy, cx, 6000, null),
    );
    if (enumerate.status !== 'Ok') { log(c.red('could not enumerate the network')); return; }
    const universe = new Map<string, [number, number]>();
    for (const f of enumerate.node_costs.features) {
      const [lng, lat] = f.geometry.coordinates;
      if (inNTA(lng, lat)) universe.set(f.properties._id, [lng, lat]);
    }
    // Every sidewalk segment with both ends inside the boundary. The comparison
    // renders segments rather than areas: it is what a person actually walks
    // on, and it avoids inventing a coverage polygon by buffering points.
    type Seg = { u: string; v: string; coords: [number, number][] };
    const segments: Seg[] = [];
    for (const f of enumerate.edges.features) {
      const u = f.properties._u as string;
      const v = f.properties._v as string;
      if (universe.has(u) && universe.has(v)) {
        segments.push({ u, v, coords: f.geometry.coordinates as [number, number][] });
      }
    }
    near = all.filter((e) => {
      if (inNTA(e.lon, e.lat)) return true;
      for (const [, [lng, lat]] of universe) {
        if (haversineM([lng, lat], [e.lon, e.lat]) <= QM) return true;
      }
      return false;
    });
    // The City's claim is about outdoor COOLING elements, which in the Cool
    // It! announcement means spray showers and misting stations. Drinking
    // fountains are in the same programme but are hydration, not cooling, and
    // there are far more of them, so counting them flatters the claim. Both
    // readings are reported rather than choosing one silently.
    const spray = near.filter((e) => !/drinking fountain$/i.test(e.kind));
    const sets: Array<[string, Elem[]]> = [
      ['spray showers and misting only', spray],
      ['including drinking fountains', near],
    ];

    log(`  ${nta}  ${meta.name}, ${meta.borough}`);
    log(c.dim(`  walkable network inside the boundary: ${universe.size.toLocaleString()} nodes`));
    log(c.dim(`  quarter mile = ${QM.toFixed(0)} m; sun_inflation ${inflation}`));

    function treeCover(e: Elem, thermal: any): Set<string> {
      const out = new Set<string>();
      const raw = JSON.parse(
        wasm.shortestPathTreeJSON('generic_pedestrian', e.lat, e.lon, QM, thermalArgsJSON(thermal)),
      );
      if (raw.status !== 'Ok') return out;
      for (const f of raw.node_costs.features) if (universe.has(f.properties._id)) out.add(f.properties._id);
      return out;
    }

    const coverageOut: Record<string, unknown> = {};
    for (const [label, elems] of sets) {
      if (!elems.length) { log(`\n  ${c.bold(label)}: none in this neighbourhood`); continue; }

      const radius = new Set<string>();
      for (const [id, [lng, lat]] of universe) {
        for (const e of elems) {
          if (haversineM([lng, lat], [e.lon, e.lat]) <= QM) { radius.add(id); break; }
        }
      }
      const walk = new Set<string>();
      const heat = new Set<string>();
      for (const e of elems) {
        for (const id of treeCover(e, THERMAL_OFF)) walk.add(id);
        for (const id of treeCover(e, { heat_aware: true, sun_inflation: inflation })) heat.add(id);
      }

      const pct = (s: Set<string>) => (100 * s.size) / Math.max(1, universe.size);
      // Area is derived from the node share, assuming walkable nodes are
      // spread evenly across the neighbourhood. In a street grid that holds
      // well enough to quote; it is an estimate, and is labelled as one.
      const km2 = (s: Set<string>) => ((pct(s) / 100) * (meta.area_km2 ?? 0));
      log('');
      log(`  ${c.bold(label)}  (${elems.length} element${elems.length === 1 ? '' : 's'})`);
      const row = (label: string, s: Set<string>, note = '') =>
        log(`    ${label.padEnd(22)} ${s.size.toLocaleString().padStart(7)} nodes ${pct(s).toFixed(1).padStart(6)}%  ${km2(s).toFixed(2).padStart(5)} km2  ${note}`);
      row('as the crow flies', radius, c.dim("the City's claim"));
      row('walking the network', walk);
      row('walking it in the heat', heat);
      log('');
      log(`    ${c.bold('gap')}  the radius claims ${(pct(radius) - pct(walk)).toFixed(1)} points (${(km2(radius) - km2(walk)).toFixed(2)} km2) more than walking delivers,`);
      log(`         and ${c.bold((pct(radius) - pct(heat)).toFixed(1) + ' points')} (${(km2(radius) - km2(heat)).toFixed(2)} km2) more than a heat-burdened resident gets`);
      // Classify each segment. A segment counts as covered when both of its
      // ends are, so a segment that merely touches the edge of a coverage set
      // is not claimed for it.
      const both = (set: Set<string>, sg: Seg) => set.has(sg.u) && set.has(sg.v);
      const round = (cs: [number, number][]) =>
        cs.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))]);
      const claimed: number[][][] = [];
      const reachable: number[][][] = [];
      const shortfall: number[][][] = [];
      for (const sg of segments) {
        const inR = both(radius, sg);
        const inH = both(heat, sg);
        if (inR) claimed.push(round(sg.coords));
        if (inH) reachable.push(round(sg.coords));
        // The figure of the comparison: pavement the quarter mile counts as
        // covered that a heat-burdened resident cannot actually walk to.
        if (inR && !inH) shortfall.push(round(sg.coords));
      }

      coverageOut[label] = {
        elements: elems.length,
        nodes_total: universe.size,
        segments_total: segments.length,
        radius: { nodes: radius.size, share: pct(radius), km2: km2(radius) },
        network: { nodes: walk.size, share: pct(walk), km2: km2(walk) },
        thermal: { nodes: heat.size, share: pct(heat), km2: km2(heat) },
        geometry: { claimed, reachable, shortfall },
      };
    }
    // Written for the comparison view to render. Computing it here keeps the
    // heavy work at build time, so the app draws two shapes and does no
    // routing of its own, which is what keeps the offline guarantee cheap.
    // data/ root, not data/thermal/, because the app serves data/ as /output/
    // and this is an app-served artifact rather than a build intermediate.
    const outPath = path.join(DATA, `${nta}-coverage.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      nta2020: nta, name: meta.name, borough: meta.borough,
      area_km2: meta.area_km2, quarter_mile_m: QM,
      // The neighbourhood outline is the denominator the view draws against.
      boundary: meta.boundary,
      sun_inflation: inflation, tier: meta.tier,
      city_claim: meta.city_claim,
      elements: near,
      readings: coverageOut,
    }));
    log(c.dim(`\n  wrote ${path.relative(REPO_ROOT, outPath)}`));
    log(c.dim(`  ${meta.city_claim.text}`));
    log(c.dim(`  ${meta.city_claim.source}`));
    return;
  }

  if (cmd === 'transit-scan') {
    // Does the thermal layer ever change a MODE or a BOARDING STATION?
    // Scans every ordered pair of transit POIs inside the surveyed
    // neighbourhoods, at a given sun_inflation, and reports only the pairs
    // where the decision actually moved.
    const inflation = rest[0] ? Number(rest[0]) : SUN_INFLATION_SENSITIVE;
    const DEPART = Number(process.env.ARIADNE_DEPART_MIN ?? 15 * 60);
    const pois = JSON.parse(fs.readFileSync(path.join(DATA, 'nyc-pois.json'), 'utf8')) as Array<any>;
    // Bounding boxes of the five surveyed neighbourhoods.
    const BOXES: Array<[number, number, number, number, string]> = [
      [-73.935, 40.650, -73.890, 40.685, 'Brownsville'],
      [-73.935, 40.800, -73.895, 40.825, 'Mott Haven'],
      [-73.915, 40.835, -73.875, 40.865, 'Tremont'],
      [-73.950, 40.790, -73.925, 40.815, 'East Harlem N'],
      [-73.885, 40.740, -73.840, 40.765, 'North Corona'],
    ];
    const inBox = (p: any) => BOXES.find((b) => p.lng > b[0] && p.lng < b[2] && p.lat > b[1] && p.lat < b[3]);
    const sites = pois.filter((p) => ['transit', 'park', 'amenity_priority'].includes(p.category) && inBox(p));
    log(c.dim(`scanning ${sites.length} sites, sun_inflation ${inflation}, departure ${Math.floor(DEPART/60)}:00`));

    let pairs = 0, modeFlips = 0, stationFlips = 0;
    for (const a of sites) {
      for (const b of sites) {
        if (a === b) continue;
        const boxA = inBox(a), boxB = inBox(b);
        if (!boxA || !boxB || boxA[4] !== boxB[4]) continue; // same neighbourhood only
        const d = Math.hypot((a.lng - b.lng) * 84000, (a.lat - b.lat) * 111000);
        if (d < 500 || d > 2500) continue;
        pairs++;
        let plain, heat;
        try {
          plain = await service.planRoute({ from: a.name, to: b.name, profile: 'generic_pedestrian', night: false, thermal: THERMAL_OFF, departure_minutes: DEPART });
          heat  = await service.planRoute({ from: a.name, to: b.name, profile: 'generic_pedestrian', night: false, thermal: { heat_aware: true, sun_inflation: inflation }, departure_minutes: DEPART });
        } catch { continue; }
        if (!plain.ok || !heat.ok) continue;
        if (plain.mode !== heat.mode) {
          modeFlips++;
          log(c.green(`  MODE  ${a.name} -> ${b.name}: ${plain.mode} -> ${heat.mode}`));
          if (heat.wait) log(c.dim(`        wait ${heat.wait.minutes} min, ${heat.wait.platform_mrt_c} C, ${heat.wait.underground ? 'underground' : 'open air'} [${heat.wait.tier}]`));
        } else if (JSON.stringify(plain.picked_stops) !== JSON.stringify(heat.picked_stops)) {
          stationFlips++;
          log(c.yellow(`  STOP  ${a.name} -> ${b.name}: board ${plain.picked_stops?.board} -> ${heat.picked_stops?.board}`));
        }
      }
    }
    log('');
    log(`  ${pairs} pairs scanned. ${modeFlips} mode changes, ${stationFlips} boarding-station changes.`);
    return;
  }

  if (cmd === 'transit') {
    const [from, to, profile = 'generic_pedestrian', inflationArg] = rest;
    const inflation = inflationArg ? Number(inflationArg) : SUN_INFLATION_DEFAULT;
    log(`from=${c.bold(from)}  to=${c.bold(to)}  profile=${c.bold(profile)}`);

    // Depart at the hour the thermal grid was built for. Comparing a wait
    // priced at the current wall clock against a 15:00 MRT field would be
    // comparing two different afternoons.
    const DEMO_DEPARTURE_MIN = Number(process.env.ARIADNE_DEPART_MIN ?? 15 * 60);
    log(c.dim(`departure ${Math.floor(DEMO_DEPARTURE_MIN / 60)}:${String(DEMO_DEPARTURE_MIN % 60).padStart(2, '0')} local, matching the thermal grid hour`));

    log(c.dim(`sun_inflation ${inflation} (beta = ${(1 + inflation).toFixed(2)}); Melnikov 2022 mean ${SUN_INFLATION_DEFAULT}, observed individual max ${SUN_INFLATION_SENSITIVE}`));
    const variants = [
      { label: 'distance-optimal', thermal: THERMAL_OFF },
      { label: 'heat-aware      ', thermal: { heat_aware: true, sun_inflation: inflation } },
    ];
    const out: any[] = [];
    for (const v of variants) {
      const r = await service.planRoute({
        from, to, profile, night: false, thermal: v.thermal,
        departure_minutes: DEMO_DEPARTURE_MIN,
      });
      out.push({ ...v, r });
    }

    log('');
    for (const { label, r } of out) {
      if (!r.ok) { log(`  ${label}  ${c.red(r.error)}`); continue; }
      const mins = Math.round((r.total_seconds ?? 0) / 60);
      log(`  ${c.bold(label)}  mode=${c.yellow(r.mode)}  ${mins} min real  ${r.walking_meters} m walking`);
      if (r.picked_stops) {
        log(`                    board ${r.picked_stops.board} -> alight ${r.picked_stops.alight}`);
      }
      if (r.wait) {
        const w = r.wait;
        const where = w.underground === null ? 'unclassified platform'
          : w.underground ? `underground (${w.platform_structure})`
          : `open air (${w.platform_structure})`;
        const mrt = w.platform_mrt_c === null ? 'no MRT' : `${w.platform_mrt_c} C`;
        log(`                    wait ${w.minutes} min at ${where}, ${mrt}, load ${w.thermal_load}x [${w.tier}]${w.truncated ? ' (capped)' : ''}`);
      }
    }

    const [plain, heat] = out;
    log('');
    if (plain.r.ok && heat.r.ok) {
      if (plain.r.mode !== heat.r.mode) {
        log(c.green(`  MODE CHANGED: ${plain.r.mode} -> ${heat.r.mode}`));
        if (heat.r.mode === 'walk_only') {
          log(c.dim('  Heat made the platform wait expensive enough that walking won.'));
        } else {
          const w = heat.r.wait;
          const where = w?.underground ? 'an underground platform' : 'the platform';
          log(c.dim(`  Heat made the street walk expensive enough that waiting on ${where} won.`));
          if (w?.underground) {
            log(c.dim(`  This is the summer inversion: ${w.platform_mrt_c} C below ground beats an exposed street above it.`));
          }
        }
      } else if (JSON.stringify(plain.r.picked_stops) !== JSON.stringify(heat.r.picked_stops)) {
        log(c.green(`  STATION CHANGED: ${plain.r.picked_stops?.board} -> ${heat.r.picked_stops?.board}`));
        log(c.dim(`  Same mode, but heat moved the boarding station.`));
      } else {
        log(c.dim(`  same mode (${plain.r.mode}) and same stops. Heat did not change the decision here.`));
      }
    }
    log(c.dim('\n  Platform MRT: proxy above ground, ASSUMED constant underground. See data/thermal-stops.json'));
    return;
  }

  if (cmd === 'thermal-suite') {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/thermal-cases.json'), 'utf8'));
    const PM: Record<string, RouterProfileId> = {
      wheelchair: 'manual_wheelchair', manual_wheelchair: 'manual_wheelchair',
      slow_walker: 'generic_pedestrian', stroller: 'generic_pedestrian',
      low_vision: 'low_vision', generic_pedestrian: 'generic_pedestrian',
    };
    const rows: string[] = [];
    let failures = 0;

    for (const t of spec.cases) {
      const a = await geocoder.geocodeAsync(t.from);
      const b = await geocoder.geocodeAsync(t.to);
      if (!a || !b) {
        rows.push(`  ${c.red('GEOCODE')}  ${t.name}: ${!a ? t.from : t.to}`);
        failures++;
        continue;
      }
      const p = PM[t.profile] ?? 'generic_pedestrian';
      let shortest, heat;
      try {
        shortest = pedestrian.route({ from: [a.lng, a.lat], to: [b.lng, b.lat], profile: p, thermal: THERMAL_OFF });
        heat = pedestrian.route({ from: [a.lng, a.lat], to: [b.lng, b.lat], profile: p, thermal: THERMAL_ON });
      } catch (e) {
        rows.push(`  ${c.red('NO PATH')}  ${t.name}: ${(e as Error).message}`);
        failures++;
        continue;
      }
      const sStats = routeThermalStats(shortest.edges as Array<{ mrt?: unknown; length?: unknown }>);
      const hStats = routeThermalStats(heat.edges as Array<{ mrt?: unknown; length?: unknown }>);
      const dLen = heat.length_m - shortest.length_m;
      const differs = Math.abs(dLen) >= 0.5;

      let verdict = c.dim('  rec  ');
      if (t.expect === 'differs') { if (differs) verdict = c.green('  pass '); else { verdict = c.red('  FAIL '); failures++; } }
      if (t.expect === 'identical') { if (!differs) verdict = c.green('  pass '); else { verdict = c.red('  FAIL '); failures++; } }

      const dMean = (hStats.mean_mrt_c ?? 0) - (sStats.mean_mrt_c ?? 0);
      const cover = `${(sStats.surveyed_share * 100).toFixed(0)}/${(hStats.surveyed_share * 100).toFixed(0)}%`;
      const meanCell = sStats.mean_mrt_c === null
        ? '    no MRT data'
        : `${sStats.mean_mrt_c.toFixed(1)} -> ${hStats.mean_mrt_c!.toFixed(1)} C`;
      rows.push(
        `${verdict} ${t.name.padEnd(46)} ${Math.round(shortest.length_m).toString().padStart(6)} m ` +
        `${(dLen >= 0 ? '+' : '') + Math.round(dLen).toString()}`.padStart(8) +
        ` m  ${meanCell.padStart(18)}  ${(dMean <= 0 ? '' : '+') + dMean.toFixed(1)} C`.padEnd(12) +
        `  ${cover.padStart(9)}`
      );
    }

    log(c.bold('\n  verdict  case                                           shortest    delta            mean MRT     change   surveyed'));
    for (const r of rows) log(r);
    log('');
    log(failures === 0 ? c.green(`  ${spec.cases.length} cases, 0 failures`) : c.red(`  ${spec.cases.length} cases, ${failures} failures`));
    log(c.dim('  MRT source: proxy (shadow and sky-view-factor), NOT SOLWEIG.'));
    if (failures) process.exitCode = 1;
    return;
  }

  if (cmd === 'thermal') {
    const [from, to, profile = 'generic_pedestrian', inflationArg] = rest;
    const inflation = inflationArg ? Number(inflationArg) : SUN_INFLATION_DEFAULT;
    const a = await geocoder.geocodeAsync(from);
    const b = await geocoder.geocodeAsync(to);
    if (!a) { log(c.red(`origin geocode miss: ${from}`)); return; }
    if (!b) { log(c.red(`destination geocode miss: ${to}`)); return; }

    const PM: Record<string, RouterProfileId> = {
      wheelchair: 'manual_wheelchair', manual_wheelchair: 'manual_wheelchair',
      slow_walker: 'generic_pedestrian', stroller: 'generic_pedestrian',
      low_vision: 'low_vision', generic_pedestrian: 'generic_pedestrian',
    };
    const p = PM[profile] ?? 'generic_pedestrian';
    log(`${a.display} -> ${b.display}   profile=${c.bold(p)}`);

    log(c.dim(`sun_inflation ${inflation} (beta ${(1 + inflation).toFixed(2)})`));
    const variants = [
      { label: 'shortest   ', thermal: THERMAL_OFF },
      { label: 'heat-aware ', thermal: { heat_aware: true, sun_inflation: inflation } },
    ];
    const results = variants.map((v) => {
      const r = pedestrian.route({ from: [a.lng, a.lat], to: [b.lng, b.lat], profile: p, thermal: v.thermal });
      const stats = routeThermalStats(r.edges as Array<{ mrt?: unknown; length?: unknown }>);
      return { ...v, r, stats };
    });

    log('');
    log(c.bold('              distance   walk    mean MRT   peak MRT   surveyed'));
    for (const { label, r, stats } of results) {
      const mins = (r.length_m / 1.25 / 60).toFixed(1);
      const mean = stats.mean_mrt_c === null ? '     n/a' : `${stats.mean_mrt_c.toFixed(1)} C`;
      const peak = stats.max_mrt_c === null ? '     n/a' : `${stats.max_mrt_c.toFixed(1)} C`;
      log(`  ${label}${Math.round(r.length_m).toString().padStart(7)} m ${mins.padStart(6)} min   ${mean.padStart(7)}    ${peak.padStart(7)}   ${(stats.surveyed_share * 100).toFixed(0).padStart(3)}%`);
    }

    const [shortest, thermal] = results;
    const dLen = thermal.r.length_m - shortest.r.length_m;
    const dPct = (dLen / Math.max(1, shortest.r.length_m)) * 100;
    const identical = Math.abs(dLen) < 0.5;

    // An unsurveyed edge carries no thermal penalty, so a heat-aware route is
    // rewarded for leaving coverage. If the two routes differ much in how much
    // of their length was surveyed, the MRT delta is measuring that escape and
    // not a genuine preference for shade. Refuse to report it rather than
    // quietly publish a flattering number.
    const coverageGap = Math.abs(thermal.stats.surveyed_share - shortest.stats.surveyed_share);
    log('');
    if (!identical && coverageGap > 0.05) {
      log(c.yellow(`  coverage differs by ${(coverageGap * 100).toFixed(0)} points between the two routes.`));
      log(c.yellow('  Not reporting a delta: the heat-aware route may simply be leaving the surveyed area,'));
      log(c.yellow('  where edges carry no penalty. Pick an origin and destination inside one neighbourhood.'));
      log(c.dim('\n  MRT source: proxy (shadow and sky-view-factor), NOT SOLWEIG. See data/thermal/*.json'));
      return;
    }
    if (identical) {
      log(c.dim('  routes are identical. No thermal signal on this pair, or no cooler alternative exists.'));
    } else {
      const dMean = (thermal.stats.mean_mrt_c ?? 0) - (shortest.stats.mean_mrt_c ?? 0);
      const dPeak = (thermal.stats.max_mrt_c ?? 0) - (shortest.stats.max_mrt_c ?? 0);
      log(`  ${c.bold('delta')}  ${dLen >= 0 ? '+' : ''}${Math.round(dLen)} m (${dPct >= 0 ? '+' : ''}${dPct.toFixed(1)}%) to drop mean MRT by ${(-dMean).toFixed(1)} C and peak MRT by ${(-dPeak).toFixed(1)} C`);
      const extraSeconds = dLen / 1.25;
      log(c.dim(`         that is ${extraSeconds.toFixed(0)} s of extra walking, priced against ${(-dMean).toFixed(1)} C of mean radiant temperature`));
    }
    log(c.dim('\n  MRT source: proxy (shadow and sky-view-factor), NOT SOLWEIG. See data/thermal/*.json'));
    return;
  }

  if (cmd === 'plan') {
    const [from, to, profile = 'generic_pedestrian'] = rest;
    log(`from=${c.bold(from)}  to=${c.bold(to)}  profile=${c.bold(profile)}`);
    const result = await service.planRoute({ from, to, profile, night: false });
    printResult(result);
    return;
  }

  if (cmd === 'find') {
    const [near, resourceType, profile = 'generic_pedestrian'] = rest;
    log(`near=${c.bold(near)}  type=${c.bold(resourceType)}  profile=${c.bold(profile)}`);
    const result = await service.findComfortAndRoute({
      near, resource_types: [resourceType], profile, night: false,
    });
    printResult(result);
    return;
  }

  if (cmd === 'reach') {
    const [near, resourceType, maxStr, profileArg] = rest;
    const args: any = {
      near,
      resource_types: [resourceType],
      profile: profileArg ?? 'generic_pedestrian',
    };
    if (maxStr) args.max_minutes = Number(maxStr);
    log(`near=${c.bold(near)}  type=${c.bold(resourceType)}  max=${args.max_minutes ?? '(default)'}`);
    const result = await service.findReachable(args);
    if (!result.ok) { log(c.red('error:'), result.error); return; }
    log(c.green('ok:'), `${result.pois.length} places within ${result.max_minutes} min of ${result.origin_name}`);
    for (const [i, p] of result.pois.slice(0, 10).entries()) {
      log(`  ${i + 1}. ${p.name} (${p.resource_types.join(',')}). ${p.walk_min} min`);
    }
    return;
  }
}

function printResult(result: any) {
  if (!result.ok) {
    log(c.red('NO PATH:'), result.error);
    return;
  }
  log(c.green('OK'));
  log(`  origin: ${result.origin_name}`);
  log(`  destination: ${result.destination_name}${result.destination_address ? ' · ' + result.destination_address : ''}`);
  log(`  profile: ${result.profile}`);
  log(`  mode: ${result.mode}`);
  if (result.mode === 'walk_transit_walk' && result.picked_stops) {
    log(`  board: ${result.picked_stops.board}`);
    log(`  alight: ${result.picked_stops.alight}`);
    log(`  transit minutes: ${result.transit_minutes}`);
  }
  if (result.transit_warning) log(c.yellow(`  warning: ${result.transit_warning}`));
  log(`  walking_meters: ${result.walking_meters}`);
  log(`  total_seconds: ${result.total_seconds} (${Math.round(result.total_seconds / 60)} min)`);
  log(`  legs: ${result.multimodal_legs?.length ?? 0}`);
  if (result.multimodal_legs) {
    for (const [i, leg] of result.multimodal_legs.entries()) {
      const len = leg.kind === 'walk' ? `${leg.length_m}m` : 'transit';
      log(`    ${i + 1}. [${leg.kind}] ${leg.from} → ${leg.to} (${len})`);
    }
  }
}

main().catch((e) => { console.error(c.red('FATAL:'), e); process.exit(1); });
