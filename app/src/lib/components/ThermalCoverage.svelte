<script lang="ts">
  /**
   * Reachability comparison view. Shows the City's quarter-mile claim against
   * the pavement a heat-burdened pedestrian can actually walk to.
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
  type Element = { lon: number; lat: number; name: string; kind: string };
  type Coverage = {
    nta2020: string;
    name: string;
    borough: string;
    area_km2: number;
    quarter_mile_m: number;
    tier: string;
    city_claim: { text: string; source: string; note?: string };
    elements: Element[];
    readings: Record<string, Reading | undefined>;
  };

  let { nta = 'BK1602' }: { nta?: string } = $props();

  const READING = 'spray showers and misting only';
  const TILE_URL = 'https://tiles.openfreemap.org/styles/positron';

  async function loadCoverage(code: string): Promise<Coverage> {
    const url = `/output/${code}-coverage.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return res.json();
  }

  const coverage = $derived(loadCoverage(nta));

  /** Spray showers and misting stations only. Drinking fountains are a different claim. */
  function sprayOnly(els: Element[]): Element[] {
    return els.filter((e) => !/drinking fountain$/i.test(e.kind.trim()));
  }

  function gapOf(r: Reading): string {
    return (r.radius.share - r.thermal.share).toFixed(1);
  }

  function shareRows(r: Reading) {
    return [
      { label: 'as the crow flies', share: r.radius.share, km2: r.radius.km2, swatch: 'claimed' },
      { label: 'walking the network', share: r.network.share, km2: r.network.km2, swatch: 'network' },
      { label: 'walking it in the heat', share: r.thermal.share, km2: r.thermal.km2, swatch: 'reachable' }
    ];
  }

  // ── Map ───────────────────────────────────────────────────────────────────
  // MapLibre paint properties cannot read CSS variables, and its colour parser
  // does not accept oklch(). A canvas context resolves the token to a form the
  // parser accepts, so the layers stay in the design system.
  let probe: CanvasRenderingContext2D | null = null;

  function token(name: string, fallback: string): string {
    probe ??= document.createElement('canvas').getContext('2d');
    if (!probe) return fallback;
    probe.fillStyle = fallback;
    probe.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return probe.fillStyle as string;
  }

  function palette() {
    return {
      claimed: token('--muted', '#6b6f76'),
      shortfall: token('--error', '#b5361f'),
      reachable: token('--primary', '#1b4a3c'),
      ring: token('--ink-2', '#3b4250'),
      element: token('--poi-cooling', '#9c4a20'),
      elementEdge: token('--surface', '#ffffff')
    };
  }

  function lines(geom: [number, number][][]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: (geom ?? []).map((coordinates) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: {}
      }))
    };
  }

  function points(els: Element[]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: els.map((e) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        properties: { name: e.name, kind: e.kind }
      }))
    };
  }

  function rings(els: Element[], radiusM: number, steps = 64): GeoJSON.FeatureCollection {
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
          properties: {}
        };
      })
    };
  }

  /**
   * Attachment factory. Re-runs when the coverage data changes, which only
   * happens when `nta` changes, so rebuilding the map is the right cost.
   */
  function thermalMap(d: Coverage, r: Reading, els: Element[]) {
    return (node: HTMLElement) => {
      let map: import('maplibre-gl').Map | null = null;
      let observer: MutationObserver | null = null;
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
        const bounds = new ml.LngLatBounds(first, first);
        for (const seg of r.geometry.claimed ?? []) for (const c of seg) bounds.extend(c);
        for (const e of els) bounds.extend([e.lon, e.lat]);

        map = new ml.Map({ container: node, style: TILE_URL, center: first, zoom: 13 });
        await new Promise<void>((res) => map!.on('load', () => res()));
        if (dead || !map) return;

        const c = palette();
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        map.addSource('claimed', { type: 'geojson', data: claimed });
        map.addSource('shortfall', { type: 'geojson', data: lines(r.geometry.shortfall) });
        map.addSource('reachable', { type: 'geojson', data: lines(r.geometry.reachable) });
        map.addSource('rings', { type: 'geojson', data: rings(els, d.quarter_mile_m) });
        map.addSource('elements', { type: 'geojson', data: points(els) });

        map.addLayer({
          id: 'claimed-line',
          type: 'line',
          source: 'claimed',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': c.claimed, 'line-width': 1, 'line-opacity': 0.9 }
        });
        map.addLayer({
          id: 'shortfall-line',
          type: 'line',
          source: 'shortfall',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': c.shortfall,
            'line-width': 7,
            'line-opacity': reduced ? 1 : 0,
            'line-opacity-transition': { duration: 420, delay: 0 }
          }
        });
        map.addLayer({
          id: 'reachable-line',
          type: 'line',
          source: 'reachable',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': c.reachable, 'line-width': 3.5, 'line-opacity': 1 }
        });
        map.addLayer({
          id: 'ring-line',
          type: 'line',
          source: 'rings',
          paint: {
            'line-color': c.ring,
            'line-width': 1.5,
            'line-dasharray': [4, 3],
            'line-opacity': 0.85
          }
        });
        map.addLayer({
          id: 'element-dot',
          type: 'circle',
          source: 'elements',
          paint: {
            'circle-radius': 7,
            'circle-color': c.element,
            'circle-stroke-width': 2.5,
            'circle-stroke-color': c.elementEdge,
            'circle-opacity': 1
          }
        });

        map.fitBounds(bounds, { padding: 56, maxZoom: 15, animate: false });

        // The one authored moment: the shortfall establishes last, so the eye
        // is led to the figure once. Skipped entirely under reduced motion.
        if (!reduced) {
          requestAnimationFrame(() => map?.setPaintProperty('shortfall-line', 'line-opacity', 1));
        }

        observer = new MutationObserver(() => {
          if (!map) return;
          const p = palette();
          map.setPaintProperty('claimed-line', 'line-color', p.claimed);
          map.setPaintProperty('shortfall-line', 'line-color', p.shortfall);
          map.setPaintProperty('reachable-line', 'line-color', p.reachable);
          map.setPaintProperty('ring-line', 'line-color', p.ring);
          map.setPaintProperty('element-dot', 'circle-color', p.element);
          map.setPaintProperty('element-dot', 'circle-stroke-color', p.elementEdge);
        });
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-mode']
        });
      })();

      return () => {
        dead = true;
        observer?.disconnect();
        map?.remove();
        map = null;
      };
    };
  }
</script>

<section class="wrap">
  {#await coverage}
    <div class="panel state">
      <h2>Loading coverage</h2>
      <p class="body">Reading the sidewalk network and the cooling elements for {nta}.</p>
    </div>
  {:then d}
    {@const reading = d.readings?.[READING]}
    {#if reading && reading.elements > 0}
      <div class="panel readout">
        <h2>{d.name}, {d.borough}</h2>
        <p class="body">
          A Heat Vulnerability Index 4 to 5 neighborhood: among the most heat-burdened communities
          the City names.
        </p>

        <blockquote>
          <p class="claim">“{d.city_claim.text}”</p>
          <cite>{d.city_claim.source}</cite>
        </blockquote>

        <div class="figure">
          <p class="figure-value">
            <span class="figure-num">{gapOf(reading)}</span><span class="figure-unit">points</span>
          </p>
          <p class="figure-label">
            The share of {d.name}'s sidewalk network that the quarter mile claims and that heat
            takes away.
          </p>
        </div>

        <ol class="shares">
          {#each shareRows(reading) as row (row.label)}
            <li>
              <span class="swatch {row.swatch}" aria-hidden="true"></span>
              <span class="share-label">{row.label}</span>
              <span class="share-pct mono">{row.share.toFixed(1)}%</span>
              <span class="share-km mono">{row.km2.toFixed(2)} km²</span>
            </li>
          {/each}
        </ol>

        <p class="body count">
          {reading.elements}
          {reading.elements === 1 ? 'cooling element serves' : 'cooling elements serve'} all
          {d.area_km2.toFixed(2)} km² of {d.name}: spray showers and misting stations, counted
          without drinking fountains.
        </p>

        <p class="honesty">
          The mean radiant temperature field here is a proxy, not SOLWEIG. The City also opens
          hydrant spray caps during heat advisories. Those are not in the published dataset and are
          not counted here.
        </p>
      </div>

      <div class="map-col">
        <!--
          The map repeats the readout, it does not replace it. Every number it
          shows is in the DOM above, reachable without touching the canvas.
        -->
        <div
          class="map"
          role="application"
          aria-label="Map of {d.name}. Every figure it shows is written out in the summary."
          {@attach thermalMap(d, reading, sprayOnly(d.elements))}
        ></div>
        <ul class="legend">
          <li>
            <span class="swatch claimed" aria-hidden="true"></span>Claimed within
            {Math.round(d.quarter_mile_m)} m
          </li>
          <li>
            <span class="swatch shortfall" aria-hidden="true"></span>Claimed, unreachable in the heat
          </li>
          <li><span class="swatch reachable" aria-hidden="true"></span>Reachable in the heat</li>
          <li><span class="dot" aria-hidden="true"></span>Cooling element and its quarter mile</li>
        </ul>
      </div>
    {:else}
      <div class="panel state">
        <h2>{d.name}, {d.borough}</h2>
        <p class="body">
          A Heat Vulnerability Index 4 to 5 neighborhood with no spray showers and no misting
          stations. There is nothing here to be a quarter mile away from. The claim covers none of
          {d.name}'s sidewalk network, because the network leads nowhere.
        </p>
        <blockquote>
          <p class="claim">“{d.city_claim.text}”</p>
          <cite>{d.city_claim.source}</cite>
        </blockquote>
        <p class="honesty">
          The mean radiant temperature field here is a proxy, not SOLWEIG. The City also opens
          hydrant spray caps during heat advisories. Those are not in the published dataset and are
          not counted here.
        </p>
      </div>
    {/if}
  {:catch err}
    <div class="panel state">
      <h2>No coverage file for {nta}</h2>
      <p class="body">
        The file did not load: <span class="mono">{err.message}</span>. Build coverage for this
        neighborhood, then reload the page. If the code is wrong, pass a 2020 NTA code such as
        BK1602.
      </p>
    </div>
  {/await}
</section>

<style>
  .wrap {
    display: grid;
    grid-template-columns: minmax(20rem, 27rem) minmax(0, 1fr);
    gap: 24px;
    height: 100%;
    min-height: 0;
    padding: 24px 16px;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-sans);
    overflow: auto;
  }

  .wrap :global(::selection) {
    background: var(--accent-2);
    color: var(--ink);
  }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border-2);
    padding: 24px;
    min-width: 0;
    align-self: start;
  }

  .state {
    grid-column: 1 / -1;
    max-width: 44rem;
  }

  h2 {
    margin-top: 8px;
    font-size: clamp(1.5rem, 1.1rem + 1.4vw, 2rem);
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.01em;
    color: var(--ink);
  }

  .body {
    margin-top: 10px;
    font-size: 0.95rem;
    line-height: 1.55;
    color: var(--ink-2);
  }

  blockquote {
    margin-top: 28px;
    padding-left: 16px;
    border-left: 1px solid var(--rule);
  }

  .claim {
    font-size: 1.02rem;
    line-height: 1.5;
    color: var(--ink);
  }

  cite {
    display: block;
    margin-top: 8px;
    font-size: 0.8rem;
    font-style: normal;
    line-height: 1.4;
    color: var(--muted);
  }

  .figure {
    margin-top: 32px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }

  .figure-value {
    display: flex;
    align-items: baseline;
    gap: 10px;
    color: var(--error);
  }

  .figure-num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: clamp(3.25rem, 2rem + 5vw, 4.75rem);
    font-weight: 500;
    line-height: 0.92;
    letter-spacing: -0.03em;
  }

  .figure-unit {
    font-size: 1rem;
    font-weight: 600;
    color: var(--ink-2);
  }

  .figure-label {
    margin-top: 12px;
    max-width: 30rem;
    font-size: 0.95rem;
    line-height: 1.5;
    color: var(--ink);
  }

  .shares {
    margin-top: 24px;
    list-style: none;
    border-top: 1px solid var(--border);
  }

  .shares li {
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) auto auto;
    align-items: baseline;
    gap: 10px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }

  .share-label {
    color: var(--ink-2);
  }

  .share-pct,
  .share-km {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .share-pct {
    color: var(--ink);
    font-weight: 500;
  }

  .share-km {
    min-width: 5.5rem;
    text-align: right;
    color: var(--muted);
  }

  .count {
    margin-top: 20px;
  }

  .honesty {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--muted);
  }

  .mono {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .map-col {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    min-height: 0;
  }

  .map {
    flex: 1;
    min-height: 420px;
    border: 1px solid var(--border-2);
    background: var(--bg-2);
  }

  .map:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    list-style: none;
    font-size: 0.8rem;
    color: var(--ink-2);
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .swatch {
    display: inline-block;
    width: 14px;
    flex: none;
    border-radius: 1px;
    background: var(--muted);
  }

  .swatch.claimed {
    height: 2px;
    background: var(--muted);
  }

  .swatch.network {
    height: 3px;
    background: var(--ink-2);
  }

  .swatch.shortfall {
    height: 7px;
    background: var(--error);
  }

  .swatch.reachable {
    height: 4px;
    background: var(--primary);
  }

  .dot {
    width: 11px;
    height: 11px;
    flex: none;
    border-radius: 50%;
    background: var(--poi-cooling);
    box-shadow: 0 0 0 2px var(--surface), 0 1px 3px rgb(0 0 0 / 0.28);
  }

  @media (max-width: 900px) {
    .wrap {
      grid-template-columns: minmax(0, 1fr);
      padding: 16px;
    }

    .panel {
      padding: 18px 16px;
    }

    .map {
      min-height: 320px;
      height: 62vh;
    }
  }
</style>
