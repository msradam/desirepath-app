<script lang="ts">
  import { queryInput, querySubmitFn, queryBusy } from '$lib/stores/query-log';

  let focused = $state(false);
  let inputEl: HTMLInputElement;

  // Demo queries verified end-to-end against Granite 4 and the live router.
  //
  // ORDER MATTERS. The thermal model covers five neighbourhoods, 7.67% of the
  // city's edges, and every one of the original six examples ran outside all
  // of them. So the feature this whole project is about never appeared unless
  // somebody happened to type a Brownsville address, and the first thing a
  // visitor saw was "not surveyed".
  //
  // The first four now run inside surveyed ground and are drawn from
  // tests/thermal-cases.json, so the route comes back painted by radiant
  // temperature. The rest are the original examples, kept because they
  // exercise multimodal routing, reachability and Spanish, and because
  // showing the honest empty state is worth doing on purpose rather than by
  // accident.
  const SUGGESTIONS = [
    // Asked the way a person asks, with no address: a neighbourhood and a
    // need. Both verified 2/2 end to end through extraction, dispatch and
    // routing.
    //
    // "nearest shelter to Mott Haven" and "find me a cooling center near
    // Tremont" were tested and are NOT here. The first routed to
    // Eastchester, a neighbourhood the geocoder matched from the word
    // "shelter", which is a silent wrong answer and worse than an error.
    // The second failed NoPath 2/2. Stage 1 puts the resource kind in
    // `destination` on that phrasing; "I need somewhere cool" leaves
    // destination empty and dispatches correctly.
    "I'm in Brownsville and I need somewhere cool to sit down, I use a wheelchair",
    // Spanish, same shape. The highest heat-vulnerability neighbourhoods in
    // New York are where Spanish is a household language, so the demo
    // should not be able to run without it once.
    //
    // "donde sentarme" was tried first and fails 2/2: it pulls linknyc and
    // wifi_power into resource_types, the nearest match is a LinkNYC kiosk,
    // and the safety check correctly refuses to send somebody who asked for
    // somewhere cool to a wifi pole. "donde descansar" reaches the same
    // destination as the English query, 2/2.
    'Estoy en Mott Haven y necesito un lugar fresco donde descansar, uso silla de ruedas',
    // Heat AND accessibility on the same route: both cost terms active at
    // once, which is the whole claim. A kerb without a ramp and 400 m of
    // unshaded asphalt are the same kind of statement about the same graph.
    "Junius Street to Betsy Head Park, manual wheelchair and I can't handle the heat",
    '125th Street Library to Abraham Lincoln Playground, power wheelchair, it is 95 degrees out',
    'Mott Haven Library to Governor Smith Playground, low vision and I overheat easily',
    // Inside the thermal model. These show the heat layer working.
    "Rockaway Avenue to Betsy Head Park, I can't handle the heat",
    '125th Street Library to Abraham Lincoln Playground, I have trouble with heat',
    'Mott Haven Library to Governor Smith Playground, manual wheelchair',
    'Cooling centers within 15 minutes of Tremont Library, I walk slowly',
    // Outside it. These show the model saying so.
    "I'm in downtown Flushing. Show me cooling centers within walking distance, wheelchair-accessible.",
    "I'm at Union Square. Closest public restroom with audible signals on the route.",
    'Estoy en Jackson Heights, Roosevelt y 74. ¿Dónde está el centro de enfriamiento más cercano?',
    'Penn Station to Grand Central, wheelchair',
    'Cooling centers within 15 minutes of Yankee Stadium, walking slowly',
    'Step-free route from Grand Central to Atlantic Terminal, manual wheelchair',
  ];

  function submit() {
    const q = $queryInput.trim();
    if (!q || $queryBusy) return;
    const fn = $querySubmitFn;
    if (!fn) return;
    focused = false;
    inputEl?.blur();
    fn(q);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { focused = false; inputEl?.blur(); }
  }

  function pickSuggestion(s: string) {
    queryInput.set(s);
    focused = false;
    const fn = $querySubmitFn;
    if (fn) fn(s);
  }
</script>

<div class="search-bar" class:focused>
  <!-- Input row -->
  <div class="search-row">
    <span class="search-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.8"/>
        <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </span>
    <input
      bind:this={inputEl}
      bind:value={$queryInput}
      class="search-input"
      type="text"
      placeholder="Search accessible routes…"
      aria-label="Search accessible routes in New York City"
      disabled={!$querySubmitFn}
      onfocus={() => focused = true}
      onblur={() => setTimeout(() => { focused = false; }, 150)}
      onkeydown={handleKeydown}
    />
    <kbd class="search-hint" aria-hidden="true">⌘K</kbd>
    {#if $queryBusy}
      <span class="search-spinner" aria-label="Searching…"></span>
    {:else if $queryInput.trim()}
      <button class="search-submit" onclick={submit} aria-label="Submit search" type="button">→</button>
    {/if}
  </div>

  <!-- Suggestions dropdown -->
  {#if focused && !$queryBusy && !$queryInput.trim()}
    <div class="suggestions" role="listbox" aria-label="Example queries">
      {#each SUGGESTIONS as s}
        <button
          class="suggestion-row"
          role="option"
          aria-selected="false"
          onmousedown={() => pickSuggestion(s)}
          type="button"
        >
          <span class="sug-arrow">→</span>
          <span class="sug-text">{s}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .search-bar {
    position: absolute;
    top: 16px;
    left: 16px;
    width: 420px;
    z-index: 20;
    background: var(--surface);
    border: 2px solid var(--ink);
    display: flex;
    flex-direction: column;
    box-shadow: 0 4px 20px rgba(0,0,0,0.25);
    transition: box-shadow 0.15s;
  }

  .search-bar.focused {
    box-shadow: 0 6px 28px rgba(0,0,0,0.35);
  }

  /* Input row */
  .search-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
  }

  .search-icon {
    flex-shrink: 0;
    color: var(--muted);
    display: flex;
    align-items: center;
  }

  .search-input {
    flex: 1;
    /* The control's own box has to clear the 24px minimum, not just the
       container it sits in: a pointer landing 3px below the text is landing on
       the wrapper, and only the input takes the caret. */
    min-height: 26px;
    padding: 2px 0;
    border: none;
    outline: none;
    background: transparent;
    font-size: 15px;
    font-weight: 500;
    font-family: var(--font-sans);
    color: var(--ink);
    min-width: 0;
  }

  .search-input::placeholder {
    color: var(--muted);
    font-weight: 400;
  }

  .search-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .search-hint {
    flex-shrink: 0;
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--muted);
    background: var(--bg-2);
    border: 1px solid var(--border);
    padding: 2px 5px;
    border-radius: 3px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .search-submit {
    flex-shrink: 0;
    background: var(--ink);
    color: var(--bg);
    border: none;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    cursor: pointer;
    transition: background 0.1s;
  }

  .search-submit:hover { background: var(--ink-2); }

  .search-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--ink);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* Suggestions */
  .suggestions {
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }

  .suggestion-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    text-align: left;
    width: 100%;
    transition: background 0.08s;
  }

  .suggestion-row:last-child { border-bottom: none; }
  .suggestion-row:hover { background: var(--bg-2); }

  .sug-arrow {
    font-size: 11px;
    color: var(--muted);
    flex-shrink: 0;
    font-family: var(--font-mono);
  }

  .sug-text {
    font-size: 12px;
    font-weight: 500;
    color: var(--ink-2);
  }

  @media (prefers-reduced-motion: reduce) {
    .search-spinner { animation: none; opacity: 0.5; }
  }
</style>
