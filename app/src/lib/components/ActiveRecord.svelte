<script lang="ts">
  import type { QueryEntry } from '$lib/stores/query-log';
  import ExampleQueries from './ExampleQueries.svelte';

  let { entry }: { entry: QueryEntry | null } = $props();

  const ROMAN = ['i','ii','iii','iv','v','vi','vii','viii','ix','x','xi','xii','xiii','xiv','xv','xvi','xvii','xviii','xix','xx'];
  function toRoman(n: number): string { return ROMAN[n - 1] ?? String(n); }
  function zeroPad(n: number) { return String(n).padStart(2, '0'); }
</script>

<div class="active-record">
  {#if entry === null}
    <!-- Empty state -->
    <div class="empty-state">
      <p class="empty-doc-text">
        DesirePath is a working reference for accessible movement through New York in the heat.
        Type a query above to consult the record.
      </p>
      <ExampleQueries />
    </div>
  {:else}
    <!-- Active record -->
    <div class="record-eyebrow">ACTIVE RECORD · {zeroPad(entry.num)}</div>

    <div class="record-card">
      {#if entry.record.streaming && !entry.record.botText && !entry.record.card}
        <!-- Thinking dots -->
        <div class="thinking-wrap">
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
          <span class="thinking-dot"></span>
        </div>
      {/if}

      {#if entry.record.card}
        {@const card = entry.record.card}
        <!--
          The destination leads. It used to sit under a kicker reading
          "CLOSEST MATCH · STEP-FREE", which is a label above a heading and
          says nothing the facts line below cannot say as a fact.
        -->
        <div class="card-header">
          <h3 class="card-name">{card.destName}</h3>
          {#if card.destAddress}
            <p class="card-address">{card.destAddress}</p>
          {/if}
        </div>

        <!--
          One line of facts, not a wall of oversized numerals.
          This was three big stats in boxes, which is the hero-metric template
          every dashboard ships, and the bottom strip already repeats every one
          of them. What is left is the thing the strip does not say.
        -->
        <p class="facts">
          <span class="fact"><span class="fact-n tnum">{card.totalMin}</span> min</span>
          {#if card.kind === 'route'}
            <span class="fact"><span class="fact-n tnum">{(card.distM / 1609).toFixed(1)}</span> mi</span>
          {:else}
            <span class="fact"><span class="fact-n tnum">{card.count}</span> {card.count === 1 ? 'site' : 'sites'}</span>
          {/if}
          <span class="fact fact-profile">{card.profile.replace(/_/g, ' ')}</span>
          {#if card.kind === 'route'}
            <span class="fact fact-mode">{card.hasTransit ? 'walk + subway' : 'step-free'}</span>
          {/if}
        </p>

        <!--
          The pavement this route actually crosses. It is the one reading no
          other router produces, so it gets its own line rather than a box in a
          grid, and it says "not surveyed" where there is no data instead of
          quietly showing a number for 7.67% of the city as though it covered
          all of it.
        -->
        {#if card.kind === 'route' && card.thermal}
          {@const t = card.thermal}
          <div class="thermal">
            <p class="thermal-label">Radiant temperature along the way</p>
            {#if t.mean_mrt_c === null}
              <p class="thermal-none">Not surveyed. This route leaves the five neighbourhoods with a thermal model.</p>
            {:else}
              <p class="thermal-read">
                <span class="thermal-n tnum">{t.mean_mrt_c.toFixed(1)}<span class="deg">°C</span></span>
                <span class="thermal-sub">mean</span>
                <span class="thermal-n thermal-n--peak tnum">{(t.max_mrt_c ?? 0).toFixed(1)}<span class="deg">°C</span></span>
                <span class="thermal-sub">peak</span>
              </p>
              <p class="thermal-cover">
                {(t.surveyed_share * 100).toFixed(0)}% of this route is surveyed. Proxy, not SOLWEIG.
              </p>
            {/if}
          </div>
        {/if}

        <!-- Type pills -->
        {#if card.destTypes.length > 0}
          <div class="pills">
            {#each card.destTypes as t}
              <span class="pill">{t.replace(/_/g, ' ')}</span>
            {/each}
          </div>
        {/if}

        <!-- Also nearby (reachable only) -->
        {#if card.kind === 'reachable' && card.alsoNearby.length > 0}
          <div class="also-section">
            <div class="also-eyebrow">ALSO NEARBY</div>
            <ol class="also-list">
              {#each card.alsoNearby as n, i}
                <li class="also-row">
                  <span class="also-letter">{String.fromCharCode(66 + i)}</span>
                  <span class="also-body">
                    <span class="also-name">{n.name}</span>
                    {#if n.address}<span class="also-addr">{n.address}</span>{/if}
                  </span>
                  <span class="also-min tnum">{n.walkMin}<span class="also-min-unit"> min</span></span>
                </li>
              {/each}
            </ol>
          </div>
        {/if}
      {/if}

      <!-- Steps -->
      {#if entry.record.steps.length > 0}
        <div class="steps-section">
          <div class="steps-header roman">I. WALK</div>
          <ol class="step-list">
            {#each entry.record.steps as step, i}
              <li class="step-row">
                <span class="roman step-num">{toRoman(i + 1)}.</span>
                <span class="step-cue">{step.instruction}</span>
                {#if step.distance_m > 0}
                  <span class="step-dist tnum">{step.distance_m}m</span>
                {/if}
              </li>
            {/each}
          </ol>
        </div>
      {/if}

      <!-- Tool summary -->
      {#if entry.record.toolSummary}
        <div class="tool-pill">
          <span class="tool-dot">●</span> {entry.record.toolSummary}
        </div>
      {/if}

      <!-- Bot text (shown when no card) -->
      {#if entry.record.botText && !entry.record.card}
        <div class="bot-text">{entry.record.botText}</div>
      {/if}
    </div>

    <!-- Always show example queries below record -->
    <ExampleQueries />
  {/if}
</div>

<style>
  .active-record {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    background: var(--bg);
  }

  /* Empty state */
  .empty-state {
    padding: 20px;
  }

  .empty-doc-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--ink-2);
    margin-bottom: 20px;
    max-width: 340px;
  }

  /* Record eyebrow */
  .record-eyebrow {
    padding: 8px 14px 6px;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
  }

  /* Record card */
  .record-card {
    margin: 0 14px 12px;
    border: 2px solid var(--ink);
    background: var(--surface);
  }

  /* Card header */
  .card-header {
    padding: 12px 16px;
    border-bottom: 2px solid var(--ink);
  }

  /* Set as a name, not as a specimen. The small-caps treatment turned every
     place in New York into the same typographic object and mangled the ones
     with numerals in them. */
  .card-name {
    font-size: 1.15rem;
    font-weight: 800;
    letter-spacing: -0.01em;
    color: var(--bone);
    line-height: 1.2;
    text-wrap: balance;
  }

  .card-address {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
  }

  /* Stats grid */

  /* Pills */
  .pills {
    padding: 8px 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    border-bottom: 1px solid var(--border);
  }

  .pill {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 3px 8px;
    border: 1.5px solid var(--border-2);
    background: var(--bg);
    color: var(--ink-2);
    font-family: var(--font-mono);
  }

  /* Also nearby */
  .also-section {
    border-top: 1px solid var(--border);
    padding: 10px 16px 12px;
  }

  .also-eyebrow {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    font-family: var(--font-mono);
    margin-bottom: 8px;
  }

  .also-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
  }

  .also-row {
    display: grid;
    grid-template-columns: 22px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px dashed var(--border);
  }

  .also-row:last-child { border-bottom: none; }

  .also-letter {
    width: 22px;
    height: 22px;
    background: var(--ink);
    color: var(--bg);
    font-size: 10px;
    font-weight: 800;
    font-family: var(--font-mono);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
  }

  .also-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .also-name {
    font-size: 12px;
    font-weight: 700;
    color: var(--ink);
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .also-addr {
    font-size: 10px;
    color: var(--muted);
    font-family: var(--font-mono);
    margin-top: 1px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .also-min {
    font-size: 14px;
    font-weight: 800;
    color: var(--ink);
    font-family: var(--font-mono);
    white-space: nowrap;
  }

  .also-min-unit {
    font-size: 9px;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.06em;
  }

  /* Steps */
  .steps-section {
    padding: 10px 16px;
    border-top: 1px solid var(--border);
  }

  .steps-header {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
    font-family: var(--font-mono);
  }

  .step-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .step-row {
    display: grid;
    grid-template-columns: 24px 1fr auto;
    gap: 6px;
    align-items: baseline;
    font-size: 12px;
    padding: 2px 0;
    border-bottom: 1px dashed var(--border);
  }

  .step-row:last-child {
    border-bottom: none;
  }

  .step-num {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    text-transform: lowercase;
  }

  .step-cue {
    color: var(--ink-2);
    font-size: 12px;
    line-height: 1.4;
  }

  .step-dist {
    font-size: 10px;
    color: var(--muted);
    font-family: var(--font-mono);
    text-align: right;
    white-space: nowrap;
  }

  /* Tool pill */
  .tool-pill {
    margin: 8px 16px;
    padding: 6px 10px;
    border: 1px dashed var(--rule);
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--muted);
    background: var(--bg-2);
  }

  .tool-dot {
    color: var(--primary);
  }

  /* Bot text */
  .bot-text {
    padding: 12px 16px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--ink-2);
  }

  /* Thinking animation */
  .thinking-wrap {
    padding: 16px;
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .thinking-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted);
    animation: thinking 1.2s ease-in-out infinite;
  }

  .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes thinking {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .thinking-dot { animation: none; opacity: 0.7; }
  }

  /* One line of facts. */
  .facts {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 16px;
    padding: 12px 14px;
    border-bottom: var(--rule-hair) solid var(--subtle);
    font-size: 0.82rem;
    color: var(--muted);
  }
  .fact-n {
    font-size: 1.15rem;
    font-weight: 800;
    color: var(--bone);
    margin-right: 2px;
  }
  .fact-mode,
  .fact-profile {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--bone-2);
  }

  /* The reading no other router produces. */
  .thermal {
    padding: 12px 14px 13px;
    border-bottom: var(--rule-hair) solid var(--subtle);
  }
  .thermal-label {
    font-family: var(--font-mono);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .thermal-read {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    margin-top: 6px;
  }
  .thermal-n {
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--reach);
  }
  .thermal-n--peak { color: var(--hivis); }
  .thermal-n .deg { font-size: 0.6em; font-weight: 700; margin-left: 1px; }
  .thermal-sub {
    font-size: 0.72rem;
    color: var(--muted);
    margin-right: 4px;
  }
  .thermal-cover,
  .thermal-none {
    margin-top: 6px;
    font-size: 0.7rem;
    line-height: 1.4;
    color: var(--muted);
  }
</style>
