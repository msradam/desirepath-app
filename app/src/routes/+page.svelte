<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';

  // Adapters
  import { FuseGeocoderAdapter } from '$lib/adapters/geocoder';
  import { UnweaverWasmAdapter } from '$lib/adapters/pedestrian-router';
  import { MinotorAdapter } from '$lib/adapters/transit-router';
  import { WebLLMGraniteAdapter } from '$lib/adapters/llm';
  import { OllamaAdapter } from '$lib/adapters/llm-ollama';
  import { WeatherAdapter } from '$lib/adapters/feed-weather';
  import { MTAOutagesAdapter } from '$lib/adapters/feed-mta-outages';
  import { LocalSpeechSynthesisAdapter } from '$lib/adapters/tts';
  import { BrowserGeolocationAdapter } from '$lib/adapters/geolocation';

  // Services
  import { privacyLog } from '$lib/services/privacy-log';
  import { RouterService } from '$lib/services/router-service';
  import { NarrationService } from '$lib/services/narration-service';
  import type { NarrationCallbacks } from '$lib/services/narration-service';
  import { ExtractionService, resolveEffects, decoderStats } from '$lib/services/extraction';
  import type { ResolvedEffects } from '$lib/services/extraction';
  import { CONDITION_DEFAULTS, CONDITION_EFFECTS } from '$lib/domain/condition-effects';
  import type { TravelProfile } from '$lib/domain/profile-grammar';
  import { CONDITION_LABELS } from '$lib/domain/profile-grammar';
  import { dispatchFor, TOOL_LABELS } from '$lib/domain/dispatch';
  import type { Tool } from '$lib/domain/dispatch';

  // Stores
  import { weather, transitState, loadPhase, loadMessage, loadProgress, graphStats } from '$lib/stores/feeds';
  import { ttsEnabled } from '$lib/stores/settings';
  import { isochroneMode, activeProfile, routeState } from '$lib/stores/route';
  import { queryLog, querySubmitFn, queryBusy } from '$lib/stores/query-log';
  import type { RouterProfileId } from '$lib/domain/profile';

  // Components
  import LoadingOverlay from '$lib/components/LoadingOverlay.svelte';
  import QueryLog from '$lib/components/QueryLog.svelte';
  import ActiveRecord from '$lib/components/ActiveRecord.svelte';
  import RouteMap from '$lib/components/RouteMap.svelte';
  import SearchBar from '$lib/components/SearchBar.svelte';

  // Domain
  import type { ComfortFeature } from '$lib/domain/poi';

  // ── Adapter instances ──────────────────────────────────────────────────────
  const geocoder = new FuseGeocoderAdapter(privacyLog);
  const pedestrian = new UnweaverWasmAdapter(privacyLog);
  const transit = new MinotorAdapter(privacyLog);
  /**
   * Granite 4, either in the browser or in Ollama on the same machine.
   *
   * Both are on-device: the sentence never reaches the internet either way.
   * Ollama is the default because the model is resident in a process instead
   * of being loaded into a tab, which removes the 20 to 29 second cold start
   * the browser path pays on every fresh profile, and lets stage 1 be tested
   * from node instead of from Chromium. The WebGPU path is still here and
   * still works: it needs nothing installed, which is the better answer for
   * somebody opening this on a phone. Append ?llm=webgpu to use it.
   */
  const llm =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('llm') === 'webgpu'
      ? new WebLLMGraniteAdapter(privacyLog)
      : new OllamaAdapter(undefined, undefined, privacyLog);
  const weatherAdapter = new WeatherAdapter(privacyLog);
  const mtaOutages = new MTAOutagesAdapter(privacyLog);
  const tts = new LocalSpeechSynthesisAdapter();
  const geolocation = new BrowserGeolocationAdapter(privacyLog);

  // ── Mutable state ──────────────────────────────────────────────────────────
  let comfortFeatures = $state<ComfortFeature[]>([]);
  let routerService = $state<RouterService | null>(null);
  let narrationService = $state<NarrationService | null>(null);
  let extractionService = $state<ExtractionService | null>(null);

  // Stage 1's output, waiting for the user. Nothing routes while this is set:
  // the whole reason the card exists is that a constraint the model dropped
  // must be visible before it can affect a route, not after.
  /**
   * What stage 1 read out of the last sentence, for disclosure after the fact.
   *
   * This is what is left of the confirmation card. It cannot prevent a route
   * being planned on a dropped constraint; it can only make the omission
   * readable once it has happened.
   */
  let inferred = $state<{
    profile: TravelProfile;
    tool: Tool;
    effects: ResolvedEffects;
    query: string;
    /** Set when dispatch had to reinterpret the request to answer it at all. */
    corrected?: string;
  } | null>(null);
  let booted = $state(false);
  let gpuError = $state('');

  // RouteMap component ref (for drawRoute / drawReachable)
  let routeMap = $state<ReturnType<typeof RouteMap> | null>(null);

  // ── TTS helper ────────────────────────────────────────────────────────────
  function speak(text: string) {
    if (!get(ttsEnabled) || !tts.supported) return;
    tts.speak(text);
  }

  /**
   * The callbacks both routing paths share.
   *
   * Extracted so the confirmed-profile path and the legacy single-shot
   * path render identically. A route that reached the map through the
   * card must not look different from one that did not.
   */
  function callbacks(entryId: string): NarrationCallbacks {
    return {
          addBot(initial) {
            queryLog.updateRecord(entryId, { streaming: true, botText: initial });
            return (text: string) => queryLog.updateRecord(entryId, { botText: text });
          },
          finishBot(text) {
            queryLog.updateRecord(entryId, { botText: text, streaming: false });
            speak(text);
          },
          addSteps(steps) {
            queryLog.updateRecord(entryId, { steps });
          },
          addTool(name, _args) {
            return (result: unknown) => {
              const r = result as Record<string, unknown> | undefined;
              let summary: string;
              if (!r?.ok) {
                summary = `${name} → error`;
              } else if (typeof r.total_minutes === 'number') {
                summary = `routed via osm_walk_graph · ${r.total_minutes} min · no network`;
              } else if (typeof r.count === 'number') {
                const within = r.budget_explicit ? ` within ${r.max_minutes} min` : '';
                summary = `routed via osm_walk_graph · ${r.count} place${r.count === 1 ? '' : 's'}${within} · no network`;
              } else {
                summary = `routed via osm_walk_graph · no network`;
              }
              queryLog.updateRecord(entryId, { toolSummary: summary });
            };
          },
          addSys(text) {
            queryLog.updateRecord(entryId, { botText: text });
            speak(text);
          },
          noteCorrection(text, tool) {
            // Into the disclosure block, which is rendered, and spoken, so the
            // reinterpretation is not something a person has to go looking for.
            if (inferred) inferred = { ...inferred, corrected: text, tool: tool ?? inferred.tool };
            speak(text);
          },
          drawRoute(result) {
            activeProfile.set(result.profile as RouterProfileId);
            const totalMin = result.total_seconds
              ? Math.round(result.total_seconds / 60)
              : Math.round((result.length_m ?? 0) / 75);
            queryLog.updateRecord(entryId, {
              card: {
                kind: 'route',
                destName: result.destination_name,
                destAddress: result.destination_address ?? '',
                destTypes: result.destination_types ?? [],
                totalMin,
                distM: Math.round(result.length_m ?? 0),
                profile: result.profile,
                hasTransit: !!(result.multimodal_legs?.some((l: any) => l.kind === 'transit')),
              }
            });
            routeMap?.drawRoute(result);
            // Persist a pulsing dot at the user's location once geolocation has been used.
            const coords = geolocation.cached();
            if (coords && result.origin_name === 'Your location') {
              routeMap?.showUserLocation(coords.lat, coords.lng);
            }
          },
          drawReachable(result, meta) {
            activeProfile.set(result.profile as RouterProfileId);
            const top = result.pois[0];
            if (top) {
              queryLog.updateRecord(entryId, {
                card: {
                  kind: 'reachable',
                  destName: top.name,
                  destAddress: top.address ?? '',
                  destTypes: top.resource_types ?? [],
                  totalMin: top.walk_min,
                  profile: result.profile,
                  origin: result.origin_name,
                  count: result.pois.length,
                  maxMinutes: result.max_minutes,
                  budgetExplicit: meta.budgetExplicit,
                  alsoNearby: result.pois.slice(1, 4).map((p) => ({
                    name: p.name,
                    address: p.address ?? '',
                    walkMin: p.walk_min,
                    types: p.resource_types ?? [],
                  })),
                }
              });
            }
            routeMap?.drawReachable(result, { budgetExplicit: meta.budgetExplicit });
            const coords = geolocation.cached();
            if (coords && result.origin_name === 'Your location') {
              routeMap?.showUserLocation(coords.lat, coords.lng);
            }
          },
    };
  }

  // ── Send handler ──────────────────────────────────────────────────────────
  //
  // All three stages, in one go. Stage 1 reads the sentence into a profile,
  // dispatch.ts picks the tool from the slots, stage 2 routes, stage 3
  // narrates.
  //
  // There is no confirmation step any more. What the model inferred is
  // disclosed on the result instead of before it, which is a real weakening of
  // the original guarantee and is recorded as such in HANDOFF.md: a constraint
  // the model dropped is now visible only after a route has been planned
  // without it. The disclosure is not optional and is not behind a control,
  // because it is the only thing left standing in for the card.
  async function handleSend(query: string) {
    if (get(queryBusy) || !routerService) return;
    if (extractionService && narrationService) {
      queryBusy.set(true);
      const entryId = queryLog.addEntry(query);
      try {
        const result = await extractionService.extract(query);
        const profile = result.profile;
        const tool = dispatchFor(profile);
        const effects = resolveEffects(profile.conditions, CONDITION_EFFECTS, CONDITION_DEFAULTS);
        inferred = { profile, tool, effects, query };
        await narrationService.runConfirmedProfile(profile, tool, effects, query, callbacks(entryId));
      } catch (e) {
        queryLog.updateRecord(entryId, {
          botText: `I could not read that into a form: ${(e as Error).message}`,
        });
      } finally {
        queryLog.finishEntry(entryId);
        queryBusy.set(false);
      }
      return;
    }
    if (!narrationService) {
      const entryId = queryLog.addEntry(query);
      const detail = gpuError ? `Error: ${gpuError}` : 'Language model not available. Try Chrome or Edge with WebGPU enabled.';
      queryLog.updateRecord(entryId, { botText: detail });
      queryLog.finishEntry(entryId);
      return;
    }
    queryBusy.set(true);
    const entryId = queryLog.addEntry(query);
    const wx = get(weather);

    try {
      await narrationService.query(query, wx, {
        ...callbacks(entryId),
      });
    } catch (e) {
      queryLog.updateRecord(entryId, { botText: `Error: ${(e as Error).message}` });
      queryLog.errorEntry(entryId);
    } finally {
      queryLog.finishEntry(entryId);
      queryBusy.set(false);
    }
  }

  // ── Boot sequence ──────────────────────────────────────────────────────────
  onMount(async () => {
    if (window.location.pathname === '/index.html') {
      window.history.replaceState({}, '', '/');
    }

    // ── Step 1: Graph ──────────────────────────────────────────────────────
    loadPhase.set('graph_loading');
    loadMessage.set('Loading WASM module…');
    loadProgress.set(0);

    try {
      await pedestrian.load((msg) => {
        loadMessage.set(msg);
        if (msg.includes('WASM')) loadProgress.set(10);
        else if (msg.includes('Fetching graph')) {
          const pct = parseInt(msg.match(/(\d+)%/)?.[1] ?? '10', 10);
          loadProgress.set(10 + Math.round(pct * 0.6));
        } else if (msg.includes('Parsing')) loadProgress.set(75);
        else if (msg.includes('profiles')) loadProgress.set(85);
      });
    } catch (e) {
      loadPhase.set('graph_error');
      loadMessage.set(`Failed to load routing graph: ${(e as Error).message}`);
      return;
    }

    const s = pedestrian.stats();
    graphStats.set({ nodes: s.nodes, edges: s.edges, pois: 0, comfort: 0 });
    loadProgress.set(90);

    // ── Step 2: Geocoder + comfort features ───────────────────────────────
    loadMessage.set('Loading place index and comfort data…');
    const [geoResult, comfort] = await Promise.allSettled([
      geocoder.load('/output/nyc-pois.json'),
      fetch('/output/nyc-comfort.json')
        .then((r) => r.ok ? r.json() : { features: [] })
        .then((d) => d?.features ?? d)
        .catch(() => []),
    ]);
    const poisCount = geoResult.status === 'fulfilled' ? geoResult.value : 0;
    if (comfort.status === 'fulfilled') {
      comfortFeatures = comfort.value as ComfortFeature[];
    }
    graphStats.update((s) => s ? { ...s, pois: poisCount, comfort: comfortFeatures.length } : null);

    // Geocoder is fully offline. The 23k named-place POI index loaded above
    // is the primary source. The structured street index (~19k streets,
    // ~1.4M housenumbers) loads in the background for address-string queries.
    geocoder.loadStreets?.('/output/nyc-streets.json').catch(() => {});

    // ── Step 3: Router service ────────────────────────────────────────────
    routerService = new RouterService(geocoder, pedestrian, transit, comfortFeatures, geolocation);
    loadPhase.set('graph_ready');
    loadProgress.set(92);

    // ── Step 4: Transit + weather (parallel, non-blocking) ────────────────
    loadMessage.set('Loading transit data and weather…');
    loadPhase.set('transit_loading');

    const transitLoadPromise = transit.load(
      '/output/timetable.bin',
      '/output/stops.bin',
      '/output/ada-stops.json',
    ).then(async () => {
      const elevState = await mtaOutages.fetch().catch(() => null);
      const impacted = elevState?.impactedAdaStopIds ?? new Set<string>();
      const removed = transit.subtractImpactedElevators(impacted);
      transitState.set({
        stopsCount: transit.stopsCount,
        adaCount: transit.adaInternalIds.size,
        elevatorsOut: removed,
        loaded: true,
      });
      routerService = new RouterService(geocoder, pedestrian, transit, comfortFeatures, geolocation);
      loadPhase.set('transit_ready');
    }).catch(() => {
      transitState.set({ stopsCount: 0, adaCount: 0, elevatorsOut: 0, loaded: false });
    });

    const weatherPromise = weatherAdapter.fetch().then((wx) => {
      weather.set(wx);
    }).catch(() => {});

    await Promise.allSettled([transitLoadPromise, weatherPromise]);
    loadProgress.set(95);

    // ── Step 5: WebGPU probe + local model load ───────────────────────────
    loadPhase.set('model_probing');
    loadMessage.set('Checking the local model…');
    const probe = await llm.probeWebGPU();
    if (!probe.ok) {
      gpuError = probe.info;
      loadPhase.set('model_error');
      loadMessage.set(`Local model unavailable: ${probe.info}`);
      booted = true;
      querySubmitFn.set(handleSend);
      return;
    }
    loadMessage.set(`${probe.info}. Loading Granite 4…`);

    loadPhase.set('model_loading');
    try {
      await llm.load((msg) => loadMessage.set(msg));
    } catch (e) {
      gpuError = (e as Error).message;
      loadPhase.set('model_error');
      loadMessage.set(`Model load failed: ${(e as Error).message}`);
      booted = true;
      querySubmitFn.set(handleSend);
      return;
    }

    narrationService = new NarrationService(llm, routerService!);
    extractionService = new ExtractionService(llm);

    // Test harness for tests/e2e/extraction.spec.ts. Stage 1 in isolation,
    // so the extraction score is not polluted by geocoder misses that have
    // nothing to do with reading a sentence into a form.
    (window as unknown as { __ariadneExtract?: unknown }).__ariadneExtract = (q: string) =>
      extractionService!.extract(q);
    (window as unknown as { __ariadneDecoderStats?: unknown }).__ariadneDecoderStats = decoderStats;
    loadPhase.set('model_ready');
    loadProgress.set(100);
    loadMessage.set('Ready');
    booted = true;
    querySubmitFn.set(handleSend);
  });

  onDestroy(() => {
    querySubmitFn.set(null);
  });

  // ── Isochrone mode toggle ─────────────────────────────────────────────────
  function toggleIsochroneMode() {
    isochroneMode.update((v) => !v);
    if (!get(isochroneMode)) routeMap?.clearMap();
  }

  // Date for plate overlay
  let now = $state(new Date());
  $effect(() => {
    const id = setInterval(() => { now = new Date(); }, 60_000);
    return () => clearInterval(id);
  });

  const plateDateStr = $derived(
    now.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).toUpperCase() + ' · ' +
    now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) + ' EDT'
  );

  const siteCountStr = $derived.by(() => {
    const rs = $routeState;
    if (rs.kind === 'route') return '1 site';
    if (rs.kind === 'reachable') {
      const n = rs.result.pois.length;
      return `${n} site${n === 1 ? '' : 's'}`;
    }
    return null;
  });

  // Derive the active/last entry for ActiveRecord
  const activeEntry = $derived(
    $queryLog.find(e => e.status === 'active') ?? ($queryLog.length > 0 ? $queryLog[$queryLog.length - 1] : null)
  );
</script>

<div class="page-layout">
  <!-- Left: query log + active record -->
  <div class="left-col" aria-label="Query record">
    <!-- The same plate the coverage notice carries, so the two screens read as
         one thing and each can be reached from the other. -->
    <header class="plate">
      <a class="wordmark" href="/">Desire<span>Path</span></a>
      <a class="cross" href="/coverage">Quarter-mile coverage →</a>
    </header>

    {#if !booted}
      <LoadingOverlay rows={[
        {
          id: 'graph',
          state: $loadPhase === 'graph_error' ? 'err' : $loadPhase === 'graph_ready' || $loadPhase.startsWith('transit') || $loadPhase.startsWith('model') ? 'ok' : 'spin',
          label: 'Routing graph',
        },
        {
          id: 'transit',
          state: $loadPhase === 'transit_ready' || $loadPhase.startsWith('model') ? 'ok' : $loadPhase === 'transit_loading' ? 'spin' : 'wait',
          label: 'Transit data',
        },
        {
          id: 'model',
          state: $loadPhase === 'model_ready' ? 'ok' : $loadPhase === 'model_error' ? 'err' : $loadPhase === 'model_loading' || $loadPhase === 'model_probing' ? 'spin' : 'wait',
          label: 'Language model',
        },
      ]} />
    {:else}
      {#if gpuError}
        <div class="gpu-error-banner">
          <strong>Model unavailable:</strong> {gpuError}
        </div>
      {/if}
      <QueryLog />
      {#if inferred}
        <!--
          What the model read out of the sentence, after the fact. Not a
          confirmation: the route below was already planned on these values.
        -->
        <section class="inferred" aria-label="What the model read from your sentence">
          <h2>Read from “{inferred.query}”</h2>
          <dl>
            <div><dt>Request</dt><dd>{TOOL_LABELS[inferred.tool]}</dd></div>
            <div>
              <dt>Conditions</dt>
              <dd>
                {#if inferred.profile.conditions.length}
                  {inferred.profile.conditions.map((c) => CONDITION_LABELS[c] ?? c).join(', ')}
                {:else}
                  none read
                {/if}
              </dd>
            </div>
            <div>
              <dt>Heat</dt>
              <dd>
                {#if inferred.effects.heat_aware}
                  priced, sun inflation {inferred.effects.sun_inflation.toFixed(2)}
                {:else}
                  not priced
                {/if}
              </dd>
            </div>
          </dl>
          {#if inferred.corrected}
            <p class="corrected">{inferred.corrected}</p>
          {/if}
          <p class="warn">
            The route below was planned on these values. If the model missed something you
            said, it is missing from the route too. Say it again more plainly and send it
            back.
          </p>
        </section>
      {/if}
      <ActiveRecord entry={activeEntry} />
    {/if}
  </div>

  <!-- Right: map plate -->
  <div class="map-col">
    <div class="plate-inner">
      <RouteMap bind:this={routeMap} {pedestrian} profile={$activeProfile} />

      <!-- Floating search bar -->
      <SearchBar />

      <!-- Date stamp (top-right) -->
      <div class="plate-date" aria-hidden="true">
        <div class="plate-eyebrow">SURVEYED{siteCountStr ? ` · ${siteCountStr.toUpperCase()}` : ''}</div>
        <div class="plate-datestr tnum">{plateDateStr}</div>
      </div>

      <!-- Legend (bottom-right). Hidden when route strip is showing -->
      {#if $routeState.kind !== 'route'}
      <div class="plate-legend" aria-hidden="true">
        <div class="legend-eyebrow">LEGEND</div>
        <div class="legend-row">
          <span class="legend-swatch legend-swatch--cooling"></span>
          <span class="legend-label">Cooling center</span>
        </div>
        <div class="legend-row">
          <span class="legend-swatch legend-swatch--access"></span>
          <span class="legend-label">Step-free station</span>
        </div>
        <div class="legend-row">
          <span class="legend-swatch legend-swatch--route"></span>
          <span class="legend-label">Active route</span>
        </div>
      </div>
      {/if}

      <!-- Bottom route strip (only when a single route is active) -->
      {#if $routeState.kind === 'route'}
        {@const r = $routeState.result}
        {@const totalMin = r.total_seconds ? Math.round(r.total_seconds / 60) : Math.round((r.length_m ?? 0) / 75)}
        {@const distMi = ((r.length_m ?? 0) / 1609).toFixed(1)}
        {@const isMultimodal = !!r.multimodal_legs?.some((l) => l.kind === 'transit')}
        <div class="route-strip" aria-label="Route summary">
          <div class="rs-block rs-block--total">
            <div class="rs-eyebrow">YOUR ROUTE</div>
            <div class="rs-total tnum">{totalMin}<span class="rs-total-unit"> min · {distMi} mi</span></div>
          </div>
          <div class="rs-block rs-block--legs">
            <div class="rs-leg">
              <span class="rs-dot rs-dot--origin"></span>
              <span class="rs-leg-meta">START</span>
              <span class="rs-leg-name">{r.origin_name}</span>
            </div>
            <div class="rs-leg">
              <span class="rs-dot rs-dot--dest"></span>
              <span class="rs-leg-meta">END</span>
              <span class="rs-leg-name">{r.destination_name}</span>
            </div>
          </div>
          <div class="rs-block rs-block--profile">
            <div class="rs-row"><span class="rs-key">PROFILE</span><span class="rs-val">{r.profile.replace(/_/g,' ')}</span></div>
            <div class="rs-row"><span class="rs-key">MODE</span><span class="rs-val">{isMultimodal ? 'walk + transit' : 'walk'}</span></div>
            <div class="rs-row"><span class="rs-key">RUNTIME</span><span class="rs-val rs-val--ok">● local</span></div>
          </div>
        </div>
      {/if}

      <!-- Isochrone toolbar -->
      {#if booted}
        <div class="map-toolbar">
          <button
            class="toolbar-btn"
            class:active={$isochroneMode}
            aria-pressed={$isochroneMode}
            onclick={toggleIsochroneMode}
            title={$isochroneMode ? 'Exit isochrone mode' : 'Click map to show reachable area'}
            type="button"
          >
            {$isochroneMode ? 'Exit isochrone' : 'Isochrone'}
          </button>
        </div>
      {/if}
    </div>

  </div>
</div>


<style>
  .page-layout {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  /* Left column */
  .plate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: var(--slate-2);
    color: var(--bone);
    border-bottom: var(--rule-hair) solid var(--subtle);
    flex: none;
  }

  .wordmark {
    font-size: 1.05rem;
    font-weight: 900;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    text-decoration: none;
    color: var(--bone);
  }
  .wordmark span { color: var(--hivis); }

  .cross {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--bone);
    text-decoration: none;
    padding: 7px 9px;
    border: 2px solid var(--subtle);
  }
  .cross:hover { border-color: var(--hivis); color: var(--hivis); }
  .cross:focus-visible { outline: 3px solid var(--hivis); outline-offset: 2px; }

  .left-col {
    width: 460px;
    flex-shrink: 0;
    border-right: var(--rule-hair) solid var(--subtle);
    display: flex;
    flex-direction: column;
    min-height: 0;
    /* Scrolls. It used to be `hidden` with no scrollable child, which silently
       clipped everything below the fold. */
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg);
  }

  .inferred {
    margin: 0 14px 14px;
    padding: 14px 16px 16px;
    background: var(--slate-3);
    border-left: 3px solid var(--hivis);
  }

  .inferred h2 {
    font-size: 0.85rem;
    font-weight: 800;
    line-height: 1.3;
    color: var(--bone);
  }

  .inferred dl {
    display: grid;
    gap: 4px;
    margin-top: 10px;
  }
  .inferred dl div {
    display: grid;
    grid-template-columns: 6.5rem minmax(0, 1fr);
    gap: 10px;
    font-size: 0.8rem;
    line-height: 1.35;
  }
  .inferred dt {
    font-family: var(--font-mono);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    padding-top: 2px;
  }
  .inferred dd { color: var(--bone); font-weight: 600; }

  .inferred .corrected {
    margin-top: 10px;
    padding: 8px 10px;
    font-size: 0.76rem;
    line-height: 1.4;
    font-weight: 600;
    color: var(--slate);
    background: var(--hivis);
  }

  .inferred .warn {
    margin-top: 10px;
    font-size: 0.74rem;
    line-height: 1.45;
    color: var(--muted);
  }

  /* Map column */
  .map-col {
    flex: 1;
    position: relative;
    background: var(--ink);
    padding: 12px;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .plate-inner {
    flex: 1;
    position: relative;
    border: 1px solid oklch(0.55 0.020 60);
    overflow: hidden;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .plate-date {
    position: absolute;
    top: 16px;
    right: 80px;
    background: var(--surface);
    border: 2px solid var(--ink);
    padding: 8px 14px;
    text-align: right;
    z-index: 10;
    pointer-events: none;
  }

  .plate-eyebrow {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
  }

  .plate-datestr {
    font-size: 11px;
    font-weight: 700;
    color: var(--ink);
    font-family: var(--font-mono);
    margin-top: 2px;
  }

  .plate-legend {
    position: absolute;
    bottom: 16px;
    right: 16px;
    background: var(--surface);
    border: 2px solid var(--ink);
    padding: 10px 14px;
    min-width: 180px;
    z-index: 10;
    pointer-events: none;
  }

  .legend-eyebrow {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
    margin-bottom: 8px;
  }

  .legend-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
  }

  .legend-row:last-child { margin-bottom: 0; }

  .legend-swatch {
    flex-shrink: 0;
  }

  /* Cooling center: teardrop */
  .legend-swatch--cooling {
    width: 14px;
    height: 14px;
    background: var(--poi-cooling);
    border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
  }

  /* Step-free: diamond */
  .legend-swatch--access {
    width: 14px;
    height: 14px;
    background: var(--poi-access);
    border-radius: 4px;
    transform: rotate(45deg);
  }

  /* Route: line */
  .legend-swatch--route {
    width: 18px;
    height: 4px;
    background: var(--route);
    border-radius: 2px;
  }

  .legend-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-2);
  }

  /* Bottom route strip */
  .route-strip {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: 16px;
    z-index: 12;
    background: var(--slate-2);
    color: var(--bone);
    border: 2px solid var(--subtle);
    display: grid;
    grid-template-columns: 220px 1fr 240px;
    align-items: stretch;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  }

  .rs-block {
    padding: 12px 18px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 4px;
    min-width: 0;
  }

  /* The total is the one cell that steps forward, so it takes the raised
     ground rather than a darker one. It used to be a near-black that went
     invisible the moment the world became dark. */
  .rs-block--total {
    background: var(--slate-3);
    border-right: var(--rule-hair) solid var(--subtle);
  }

  .rs-eyebrow {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
  }

  .rs-total {
    font-size: 32px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
  }

  .rs-total-unit {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0;
    opacity: 0.7;
  }

  .rs-block--legs {
    border-right: var(--rule-hair) solid var(--subtle);
    gap: 8px;
  }

  .rs-leg {
    display: grid;
    grid-template-columns: 14px 60px 1fr;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .rs-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: rgba(255,255,255,0.6);
  }

  .rs-dot--dest {
    background: var(--accent);
    border-radius: 50% 50% 50% 0;
    transform: rotate(-45deg);
  }

  .rs-leg-meta {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.18em;
    color: var(--muted);
    font-family: var(--font-mono);
  }

  .rs-leg-name {
    font-size: 13px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rs-block--profile { gap: 3px; }

  .rs-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 10px;
    font-family: var(--font-mono);
  }

  .rs-key {
    color: var(--muted);
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .rs-val {
    font-weight: 700;
    text-transform: capitalize;
    letter-spacing: 0.04em;
  }

  .rs-val--ok { color: var(--ok); }

  /* Toolbar */
  .map-toolbar {
    position: absolute;
    bottom: 148px;
    right: 16px;
    z-index: 10;
  }

  .toolbar-btn {
    padding: 6px 14px;
    border: 2px solid var(--ink);
    background: var(--surface);
    color: var(--ink);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-family: var(--font-sans);
    cursor: pointer;
    transition: background 0.12s;
    white-space: nowrap;
    min-height: 36px;
  }

  .toolbar-btn:hover { background: var(--bg-2); }
  .toolbar-btn.active {
    background: var(--primary);
    border-color: var(--primary);
    color: oklch(0.97 0.01 165);
  }

  .gpu-error-banner {
    padding: 10px 16px;
    background: oklch(0.25 0.05 25);
    border-bottom: 2px solid var(--error);
    font-size: 11px;
    color: oklch(0.85 0.04 25);
    font-family: var(--font-mono);
    line-height: 1.5;
    word-break: break-word;
  }

  /* ──────────────────────────────────────────────────────────────────────
     Responsive layout
     ──────────────────────────────────────────────────────────────────────

     Tablet (641-1024px). Keep side-by-side, shrink left column.
     Phone   (≤640px)   . Stack vertically: map on top, query log below.

     The map is the primary surface on phones: it gets ~55vh, the query-log
     panel scrolls in the remaining ~45vh. The bottom route-strip overlay
     reflows from horizontal-3-column to vertical so it fits a phone width.
  */

  /* Tablet. Narrower left column */
  @media (max-width: 1024px) and (min-width: 641px) {
    .left-col { width: 340px; }
  }

  /* Phone. Stack vertically */
  @media (max-width: 640px) {
    .page-layout {
      flex-direction: column;
    }
    .left-col {
      width: 100%;
      height: 45vh;
      min-height: 0;
      border-right: none;
      border-bottom: 3px solid var(--ink);
      order: 2;
    }
    .map-col {
      width: 100%;
      height: 55vh;
      flex: 0 0 55vh;
      padding: 0;
      order: 1;
    }
    .plate-inner {
      border: none;
    }

    /* Map overlays cut their margins so they don't crowd the small canvas */
    :global(.search-bar) {
      width: calc(100vw - 16px) !important;
      left: 8px !important;
      top: 8px !important;
    }
    .plate-date {
      top: 8px;
      right: 60px;
      padding: 4px 8px;
      font-size: 9px;
    }
    :global(.map-controls) {
      top: 8px !important;
      right: 8px !important;
    }
    :global(.ctrl-btn) {
      width: 36px !important;
      height: 36px !important;
    }
    .plate-legend {
      display: none;          /* free up bottom-right corner on phones */
    }
    .map-toolbar {
      bottom: 12px;
      right: 12px;
    }

    /* Route strip: stack the three columns vertically + smaller padding */
    .route-strip {
      grid-template-columns: 1fr;
      left: 8px;
      right: 8px;
      bottom: 8px;
    }
    .rs-block {
      padding: 8px 12px;
    }
    .rs-block--total {
      border-right: none;
      border-bottom: var(--rule-hair) solid var(--subtle);
    }
    .rs-block--legs {
      border-right: none;
      border-bottom: var(--rule-hair) solid var(--subtle);
    }
    .rs-total { font-size: 24px; }
    .rs-leg-name { font-size: 12px; }
  }

  /* Phone in landscape. Give the map more room since vertical real estate is tight */
  @media (max-width: 900px) and (orientation: landscape) and (max-height: 500px) {
    .map-col { height: 60vh; flex: 0 0 60vh; }
    .left-col { height: 40vh; }
  }
</style>
