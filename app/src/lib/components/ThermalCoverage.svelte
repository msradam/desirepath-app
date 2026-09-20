<script lang="ts">
  /**
   * The coverage view. One notice, full bleed.
   *
   * The City claims no New Yorker in its most heat-burdened communities is more
   * than a quarter mile from an outdoor cooling element. That quarter mile is a
   * straight line. This measures the same claim along the sidewalk a person
   * actually has to walk, with heat priced into every metre, and shows the
   * pavement the claim counts and nobody can reach.
   *
   * The shortfall is the artifact, so the map gets the screen and the reading
   * sits on the sign's furniture around it. Every fill that carries meaning
   * carries a second channel as well, a dash pattern or a hatch, because this
   * is projected into a bright room where colour alone does not survive.
   */

  type Share = { nodes: number; share: number; km2: number };
  type Reading = {
    elements: number;
    nodes_total: number;
    segments_total: number;
    radius: Share;
    network: Share;
    thermal: Share;
    geometry: {
      claimed: [number, number][][];
      reachable: [number, number][][];
      shortfall: [number, number][][];
    };
  };
  type CoolingElement = { lon: number; lat: number; name: string; kind: string };
  type Coverage = {
    nta2020: string;
    name: string;
    borough: string;
    /** Optional: an older coverage file may predate this field. */
    area_km2?: number;
    quarter_mile_m: number;
    tier: string;
    city_claim: { text: string; source: string; note?: string };
    boundary: GeoJSON.MultiPolygon | GeoJSON.Polygon;
    elements: CoolingElement[];
    readings: Record<string, Reading | undefined>;
  };

  let { nta = 'BK1602' }: { nta?: string } = $props();

  const READING = 'spray showers and misting only';
  const TILE_URL = 'https://tiles.openfreemap.org/styles/dark';

  async function loadCoverage(code: string): Promise<Coverage> {
    const url = `/output/${code}-coverage.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return res.json();
  }

  const coverage = $derived(loadCoverage(nta));

  /** Spray showers and misting stations only. Drinking fountains are a different claim. */
  function sprayOnly(els: CoolingElement[]): CoolingElement[] {
    return els.filter((e) => !/drinking fountain$/i.test(e.kind.trim()));
  }

  function gapOf(r: Reading): string {
    return (r.radius.share - r.thermal.share).toFixed(1);
  }

  /**
   * The three readings, worst last.
   *
   * Each carries what it is down from, not only its own value: a percentage on
   * its own invites the reader to decide for themselves whether it is bad.
   */
  function shareRows(r: Reading) {
    return [
      {
        key: 'claimed',
        label: 'As the crow flies',
        sub: 'what the quarter mile counts',
        share: r.radius.share,
        km2: r.radius.km2,
        delta: null as string | null,
      },
      {
        key: 'network',
        label: 'Walking the network',
        sub: 'along real sidewalks and crossings',
        share: r.network.share,
        km2: r.network.km2,
        delta: (r.network.share - r.radius.share).toFixed(1),
      },
      {
        key: 'reachable',
        label: 'Walking it in the heat',
        sub: 'sun priced into every metre',
        share: r.thermal.share,
        km2: r.thermal.km2,
        delta: (r.thermal.share - r.radius.share).toFixed(1),
      },
    ];
  }

  // ── Map ───────────────────────────────────────────────────────────────────
  // MapLibre paint properties cannot read CSS variables. Painting the token
  // onto a canvas and reading the pixel back hands the conversion to the
  // browser, so the layers stay in the design system and follow the theme.
  let probe: CanvasRenderingContext2D | null = null;

  function token(name: string, fallback: string): string {
    probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!probe) return fallback;
    probe.fillStyle = fallback;
    probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }

  function palette() {
    return {
      claimed: token('--muted', '#8C9AAB'),
      shortfall: token('--hivis', '#FFC400'),
      reachable: token('--reach', '#5FD4E8'),
      paper: token('--slate', '#10263F'),
      bone: token('--bone', '#F5F1E8'),
    };
  }

  /**
   * The element marker, drawn rather than picked from a circle.
   *
   * A square with a hole in it is the municipal site marker, and it is the one
   * shape on the map that is neither a route nor a boundary, so it should not
   * borrow either of their vocabularies.
   */
  function markerImage(ink: string, paper: string): ImageData {
    const s = 22;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d')!;
    g.fillStyle = paper;
    g.fillRect(0, 0, s, s);
    g.fillStyle = ink;
    g.fillRect(0, 0, s, 4);
    g.fillRect(0, s - 4, s, 4);
    g.fillRect(0, 0, 4, s);
    g.fillRect(s - 4, 0, 4, s);
    g.fillRect(7, 7, s - 14, s - 14);
    return g.getImageData(0, 0, s, s);
  }

  /** Outer rings of a Polygon or MultiPolygon, for fitting and for drawing. */
  function boundaryRings(b: GeoJSON.MultiPolygon | GeoJSON.Polygon): [number, number][][] {
    const polys = b.type === 'MultiPolygon' ? b.coordinates : [b.coordinates];
    return polys.map((poly) => poly[0] as [number, number][]);
  }

  function boundaryFC(b: GeoJSON.MultiPolygon | GeoJSON.Polygon): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: b, properties: {} }],
    };
  }

  function lines(geom: [number, number][][]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: (geom ?? []).map((coordinates) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {},
      })),
    };
  }

  function points(els: CoolingElement[]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: els.map((e) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        properties: { name: e.name, kind: e.kind },
      })),
    };
  }

  function rings(els: CoolingElement[], radiusM: number, steps = 64): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: els.map((e) => {
        const coords: [number, number][] = [];
        for (let i = 0; i <= steps; i++) {
          const angle = (i / steps) * 2 * Math.PI;
          const dLat = (radiusM / 111320) * Math.cos(angle);
          const dLng = (radiusM / (111320 * Math.cos((e.lat * Math.PI) / 180))) * Math.sin(angle);
          coords.push([e.lon + dLng, e.lat + dLat]);
        }
        return {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [coords] },
          properties: {},
        };
      }),
    };
  }

  /**
   * Attachment factory. Re-runs when the coverage data changes, which only
   * happens when `nta` changes, so rebuilding the map is the right cost.
   */
  function thermalMap(d: Coverage, r: Reading, els: CoolingElement[]) {
    return (node: HTMLElement) => {
      let map: import('maplibre-gl').Map | null = null;
      let observer: MutationObserver | null = null;
      let resizer: ResizeObserver | null = null;
      let dead = false;

      (async () => {
        let ml = (window as any).__maplibre;
        if (!ml) {
          ml = await import('maplibre-gl');
          await import('maplibre-gl/dist/maplibre-gl.css');
          (window as any).__maplibre = ml;
        }
        if (dead) return;

        const claimed = lines(r.geometry.claimed);
        const first = r.geometry.claimed?.[0]?.[0] ?? [els[0]?.lon ?? -73.9, els[0]?.lat ?? 40.66];
        // Fit to the whole neighbourhood, not to the covered clusters. The
        // argument is how little of the neighbourhood those clusters are;
        // fitting to them crops away the denominator.
        const bounds = new ml.LngLatBounds(first, first);
        for (const ring of boundaryRings(d.boundary)) for (const c of ring) bounds.extend(c);
        for (const seg of r.geometry.claimed ?? []) for (const c of seg) bounds.extend(c);
        for (const e of els) bounds.extend([e.lon, e.lat]);

        map = new ml.Map({
          container: node,
          style: TILE_URL,
          center: first,
          zoom: 13,
          attributionControl: { compact: true },
        });
        await new Promise<void>((res) => map!.on('load', () => res()));
        if (dead || !map) return;

        const c = palette();
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        map.addImage('site', markerImage(c.bone, c.paper));

        map.addSource('boundary', { type: 'geojson', data: boundaryFC(d.boundary) });
        map.addSource('claimed', { type: 'geojson', data: claimed });
        map.addSource('shortfall', { type: 'geojson', data: lines(r.geometry.shortfall) });
        map.addSource('reachable', { type: 'geojson', data: lines(r.geometry.reachable) });
        map.addSource('rings', { type: 'geojson', data: rings(els, d.quarter_mile_m) });
        map.addSource('elements', { type: 'geojson', data: points(els) });

        // The neighbourhood outline is the denominator. Without it a viewer
        // reads the covered clusters as the whole picture, and the argument is
        // exactly how much of the picture they are not.
        map.addLayer({
          id: 'boundary-line',
          type: 'line',
          source: 'boundary',
          layout: { 'line-join': 'miter' },
          paint: { 'line-color': c.bone, 'line-width': 2.5 },
        });
        // Claimed pavement: a hairline, dotted. Colour is the third channel
        // here, never the only one.
        map.addLayer({
          id: 'claimed-line',
          type: 'line',
          source: 'claimed',
          layout: { 'line-join': 'miter', 'line-cap': 'butt' },
          paint: {
            'line-color': c.claimed,
            'line-width': 1.5,
            'line-dasharray': [1, 2],
            'line-opacity': 0.7,
          },
        });
        // The figure. Barricade orange, and chunky dashes so it reads as
        // hatched work area rather than as a route.
        map.addLayer({
          id: 'shortfall-line',
          type: 'line',
          source: 'shortfall',
          layout: { 'line-join': 'miter', 'line-cap': 'butt' },
          paint: {
            'line-color': c.shortfall,
            'line-width': 8,
            'line-dasharray': [1.6, 0.9],
            'line-opacity': reduced ? 1 : 0,
            'line-opacity-transition': { duration: 420, delay: 0 },
          },
        });
        map.addLayer({
          id: 'reachable-line',
          type: 'line',
          source: 'reachable',
          layout: { 'line-join': 'miter', 'line-cap': 'butt' },
          paint: { 'line-color': c.reachable, 'line-width': 4, 'line-opacity': 1 },
        });
        map.addLayer({
          id: 'ring-line',
          type: 'line',
          source: 'rings',
          paint: {
            'line-color': c.bone,
            'line-width': 1.75,
            'line-dasharray': [5, 4],
            'line-opacity': 0.75,
          },
        });
        map.addLayer({
          id: 'element-dot',
          type: 'symbol',
          source: 'elements',
          layout: { 'icon-image': 'site', 'icon-allow-overlap': true, 'icon-size': 1 },
        });

        // Fit after a resize, not before one. The container is a grid track
        // that has no height until layout settles, and fitBounds against a
        // zero-height viewport silently lands on the whole tri-state area.
        //
        // The padding scales with the container because a fixed 64px inset is
        // most of the height on a phone, which leaves fitBounds nothing to
        // work with and lands the neighbourhood in a corner.
        const fit = () => {
          if (!map) return;
          map.resize();
          const { clientWidth: w, clientHeight: h } = node;
          const pad = Math.max(8, Math.min(64, Math.floor(Math.min(w, h) / 7)));
          map.fitBounds(bounds, { padding: pad, maxZoom: 15, animate: false });
        };
        fit();

        // And keep it fitted: the projector, the phone and a window drag all
        // change the track's height after the first paint.
        const ro = new ResizeObserver(fit);
        ro.observe(node);
        resizer = ro;

        // The one authored moment: the shortfall prints last, the way a second
        // pass of the press lands on a sheet already carrying the first.
        if (!reduced) {
          requestAnimationFrame(() => map?.setPaintProperty('shortfall-line', 'line-opacity', 1));
        }

        observer = new MutationObserver(() => {
          if (!map) return;
          const p = palette();
          map.setPaintProperty('boundary-line', 'line-color', p.bone);
          map.setPaintProperty('claimed-line', 'line-color', p.claimed);
          map.setPaintProperty('shortfall-line', 'line-color', p.shortfall);
          map.setPaintProperty('reachable-line', 'line-color', p.reachable);
          map.setPaintProperty('ring-line', 'line-color', p.bone);
          if (map.hasImage('site')) map.removeImage('site');
          map.addImage('site', markerImage(p.bone, p.paper));
        });
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-mode'],
        });
      })();

      return () => {
        dead = true;
        resizer?.disconnect();
        observer?.disconnect();
        map?.remove();
        map = null;
      };
    };
  }
</script>

{#await coverage}
  <section class="notice state">
    <p class="stencil">Reading the sidewalk network for {nta}</p>
  </section>
{:then d}
  {@const reading = d.readings?.[READING]}
  {#if reading && reading.elements > 0}
    <section class="notice">
      <!--
        A heading and a sentence, not a scoreboard.
        This read as a dashboard: a 6rem numeral shouting a figure whose units
        nobody had explained yet, with the sentence that gives it meaning set
        smaller than the decoration around it. The number is the conclusion, so
        it now arrives at the end of a sentence, at the size of a sentence.
      -->
      <header class="band">
        <h2 class="where">{d.name}<span class="boro">, {d.borough}</span></h2>
        <p class="lede">
          The City counts <strong>{reading.radius.share.toFixed(1)}%</strong> of the sidewalk
          network here as within a quarter mile of somewhere to cool down. Walking it in the
          heat reaches <strong class="short">{reading.thermal.share.toFixed(1)}%</strong>.
        </p>
      </header>

      <div class="sheet">
        <div
          class="map"
          role="application"
          aria-label="Map of {d.name}. Every figure it shows is written out below it."
          {@attach thermalMap(d, reading, sprayOnly(d.elements))}
        ></div>

        <ul class="key">
          <li><span class="mark claimed" aria-hidden="true"></span>Counted as covered</li>
          <li><span class="mark shortfall" aria-hidden="true"></span>Counted, unreachable in heat</li>
          <li><span class="mark reachable" aria-hidden="true"></span>Reachable in heat</li>
          <li><span class="mark site" aria-hidden="true"></span>Cooling element, quarter mile</li>
        </ul>
      </div>

      <footer class="stamp">
        <!--
          A table, because this is three measurements of one quantity and that
          is what a table is for. It was a stack of oversized percentages with
          a coloured chip each, which made three comparable numbers look like
          three unrelated headline stats.
        -->
        <table class="readings">
          <caption class="sr-only">
            Share of {d.name}'s sidewalk network within a quarter mile of a cooling element,
            measured three ways
          </caption>
          <thead>
            <tr><th scope="col">Measured</th><th scope="col">Share</th><th scope="col">Against the claim</th></tr>
          </thead>
          <tbody>
            {#each shareRows(reading) as row (row.key)}
              <tr class:worst={row.key === 'reachable'}>
                <th scope="row">
                  <span class="mark {row.key}" aria-hidden="true"></span>
                  <span class="r-label">{row.label}</span>
                  <span class="r-sub">{row.sub}</span>
                </th>
                <td class="r-pct">{row.share.toFixed(1)}%</td>
                <td class="r-delta">
                  {#if row.delta}{row.delta} pts{:else}&mdash;{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="census">
          <p class="census-say">
            <strong>{reading.elements}</strong>
            {reading.elements === 1 ? 'cooling element' : 'cooling elements'} for
            {d.area_km2 ? `${d.area_km2.toFixed(2)} km² of ` : 'all of '}{d.name}.
            Spray showers and misting stations, counted without drinking fountains.
          </p>
          <p class="honesty">
            The claim under test: “{d.city_claim.text}” {d.city_claim.source}.
            Radiant temperature here is a proxy, not SOLWEIG. The City also opens hydrant spray
            caps during heat advisories; those are not in the published dataset and are not
            counted.
          </p>
        </div>
      </footer>
    </section>
  {:else}
    <section class="notice zero">
      <div class="zero-body">
        <p class="zero-num">0</p>
        <div>
          <p class="zero-say">
            No spray showers. No misting stations. There is nothing in {d.name} to be a quarter
            mile away from.
          </p>
          <p class="honesty">
            A Heat Vulnerability Index 4 to 5 neighbourhood. The claim covers none of {d.name}'s
            sidewalk network, because the network leads nowhere. The claim under test:
            “{d.city_claim.text}” {d.city_claim.source}.
          </p>
        </div>
      </div>
    </section>
  {/if}
{:catch err}
  <section class="notice state">
    <p class="stencil">No coverage file for {nta}</p>
    <p class="honesty">
      The file did not load: <span class="mono">{err.message}</span>. Build coverage for this
      neighbourhood, then reload. If the code is wrong, pass a 2020 NTA code such as BK1602.
    </p>
  </section>
{/await}

<style>
  /* One sheet. Claim on top, evidence in the middle, the stamp at the foot. */
  .notice {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100%;
    min-height: 0;
    background: var(--slate);
    color: var(--ink);
    font-family: var(--font-sans);
  }

  /* ── The band ──────────────────────────────────────────────────────────
     A heading and one sentence. The map starts immediately under it. */
  .band {
    padding: 16px 24px 18px;
    border-bottom: var(--rule-hair) solid var(--subtle);
  }

  .where {
    font-size: 1.05rem;
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: 0.01em;
    text-transform: uppercase;
    color: var(--bone);
  }
  .boro { color: var(--muted); font-weight: 600; }

  /* The figures sit inside the sentence that explains them rather than above
     it at display size. Emphasis is weight and one colour, not scale. */
  .lede {
    max-width: 72ch;
    margin-top: 7px;
    font-size: clamp(0.95rem, 0.85rem + 0.42vw, 1.25rem);
    font-weight: 400;
    line-height: 1.5;
    color: var(--bone-2);
  }
  .lede strong { font-weight: 800; color: var(--bone); }
  .lede strong.short { color: var(--hivis); }

  /* ── The evidence ──────────────────────────────────────────────────────── */
  .sheet {
    position: relative;
    min-height: 0;
    border-bottom: var(--rule-heavy) solid var(--ink);
  }

  .map {
    position: absolute;
    inset: 0;
    background: var(--slate-2);
  }

  .map :global(.maplibregl-ctrl-attrib) {
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--paper);
    color: var(--muted);
    border-radius: 0;
  }
  .map :global(.maplibregl-ctrl-attrib a) { color: var(--muted); }

  /* The key is stamped onto the sheet, not floated over it: square corners,
     solid ground, a heavy rule, no shadow and no translucency. */
  .key {
    position: absolute;
    left: 16px;
    bottom: 16px;
    z-index: 2;
    display: grid;
    gap: 7px;
    padding: 12px 14px;
    list-style: none;
    background: var(--paper);
    border: 3px solid var(--ink);
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.1;
  }

  .key li {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  /* Every mark carries its pattern, so the key survives a bad projector and a
     viewer who cannot separate orange from blue. */
  .mark {
    flex: none;
    display: inline-block;
    width: 26px;
    height: 10px;
    border: 1px solid var(--ink);
  }
  .mark.claimed {
    height: 0;
    border: 0;
    border-top: 2px dotted var(--ink);
  }
  .mark.shortfall {
    background: repeating-linear-gradient(
      -45deg,
      var(--barricade) 0 4px,
      #000 4px 7px
    );
    border-color: var(--ink);
  }
  .mark.network {
    background: repeating-linear-gradient(
      -45deg,
      var(--muted) 0 4px,
      var(--paper) 4px 7px
    );
  }
  .mark.reachable {
    background: var(--signal);
  }
  .mark.site {
    width: 14px;
    height: 14px;
    background: var(--paper);
    border: 3px solid var(--ink);
    box-shadow: inset 0 0 0 3px var(--paper), inset 0 0 0 7px var(--ink);
  }

  /* ── The stamp ─────────────────────────────────────────────────────────── */
  .stamp {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
    gap: 0 32px;
    padding: 14px 24px 16px;
    background: var(--slate-2);
  }

  .readings {
    border-collapse: collapse;
    width: 100%;
    font-variant-numeric: tabular-nums;
  }

  .readings thead th {
    padding: 0 10px 5px 0;
    font-family: var(--font-mono);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    text-align: left;
    color: var(--muted);
    border-bottom: var(--rule-hair) solid var(--subtle);
  }
  .readings thead th:not(:first-child) { text-align: right; }

  .readings tbody th {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px 7px 0;
    font-weight: 400;
    text-align: left;
  }

  .readings td {
    padding: 7px 0 7px 10px;
    text-align: right;
    white-space: nowrap;
  }

  .readings tbody tr + tr th,
  .readings tbody tr + tr td {
    border-top: var(--rule-hair) solid rgba(122, 144, 168, 0.35);
  }

  .r-label { font-size: 0.85rem; font-weight: 700; color: var(--bone); }
  .r-sub { font-size: 0.75rem; color: var(--muted); }

  .r-pct { font-size: 1rem; font-weight: 700; color: var(--bone); }
  .r-delta { font-family: var(--font-mono); font-size: 0.78rem; color: var(--muted); }

  /* The reading the argument rests on. One row carries emphasis; the rest are
     the comparison that makes it mean something. */
  .readings tr.worst .r-pct { color: var(--hivis); font-weight: 800; }
  .readings tr.worst .r-delta { color: var(--hivis); }
  .readings tr.worst .r-label { text-decoration: underline; text-underline-offset: 3px; }

  .census {
    align-self: start;
    padding-left: 30px;
    border-left: var(--rule-hair) solid var(--subtle);
  }

  .census-say {
    font-size: 0.82rem;
    line-height: 1.45;
    color: var(--bone-2);
  }
  .census-say strong { font-weight: 800; color: var(--bone); }

  .honesty {
    margin-top: 9px;
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--muted);
  }

  /* ── Zero and fallback states ──────────────────────────────────────────── */
  /* These states are one block, centred. The row is auto rather than 1fr so
     the block is the height of its content instead of stretching into a sheet
     of empty rule. */
  .zero,
  .state {
    grid-template-rows: auto;
    align-content: center;
    justify-content: center;
    padding: 32px 24px;
    overflow: auto;
  }

  .zero-body {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 36px;
    width: min(100%, 76rem);
    padding: 40px 44px 44px;
    border: var(--rule-heavy) solid var(--ink);
    background: var(--paper);
  }

  .zero-num {
    font-size: clamp(6rem, 3rem + 13vw, 16rem);
    font-weight: 900;
    line-height: 0.78;
    letter-spacing: -0.05em;
    color: var(--barricade-deep);
  }

  .zero-say {
    max-width: 30ch;
    font-size: clamp(1.25rem, 0.8rem + 1.9vw, 2.6rem);
    font-weight: 800;
    line-height: 1.2;
    text-wrap: balance;
  }
  .zero-body .honesty { margin-top: 16px; max-width: 58ch; font-size: 0.8rem; }

  .stencil {
    font-size: clamp(1.1rem, 0.9rem + 0.8vw, 1.6rem);
    font-weight: 800;
    letter-spacing: 0.01em;
  }
  .state .honesty { margin-top: 10px; max-width: 60ch; }

  /* ── Narrow ────────────────────────────────────────────────────────────── */
  @media (max-width: 62rem) {
    .band {
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
    }
        .gap-say { margin-left: 0; }

    .stamp {
      grid-template-columns: minmax(0, 1fr);
      gap: 14px;
      padding: 12px 16px 14px;
    }
    /* The third column is the comparison, and it is the first thing that has
       to go when there is no room for it. */
    .r-sub { display: none; }
    .readings thead th:last-child,
    .readings td.r-delta { display: none; }
    .census {
      padding-left: 0;
      padding-top: 12px;
      border-left: 0;
      border-top: var(--rule-hair) solid var(--subtle);
    }
    /* The evidence must stay the largest thing on the sheet, even on a phone
       where the band and the stamp both want the room. */
    /* On a phone the three blocks do not fit one screen and squeezing them
       until they do is how the readings ended up cropped. The notice scrolls
       instead, and the map keeps a real share of the first screen. */
    .notice {
      grid-template-rows: auto auto auto;
      overflow-y: auto;
    }
    .sheet {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-height: 52vh;
    }
    /* The key precedes the map here, but only visually: the DOM keeps the map
       first so the reading order still goes evidence, then legend. */
    .map { position: relative; inset: auto; min-height: 0; order: 2; }

    /* The key stops floating over a map this small and becomes a strip under
       the band, two up, where it covers nothing. */
    .key {
      position: static;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 5px 10px;
      padding: 8px 16px 9px;
      border: 0;
      border-bottom: var(--rule-hair) solid var(--ink);
      background: var(--paper-2);
      font-size: 0.68rem;
      order: 1;
    }
    .zero-body { grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 20px; }
    .zero-num { line-height: 0.85; }
  }
</style>
