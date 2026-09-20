<script lang="ts">
  import { queryInput } from '$lib/stores/query-log';

  // Heat-showing examples first. The thermal model covers five neighbourhoods,
  // and all five of the originals ran outside every one of them, so the first
  // thing anybody clicking down this list saw was "not surveyed". The
  // originals are kept below, because the empty state is worth showing on
  // purpose.
  const EXAMPLES = [
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
    // Asks for the wifi kiosk on purpose, which is the same resource the
    // Spanish query above is refused. A LinkNYC pole is a correct answer to
    // "I need wifi" and a wrong one to "I need somewhere cool", and the
    // safety check is what knows the difference. 2/2.
    "I'm in Mott Haven and I need free wifi and somewhere to charge my phone",
    // Heat AND accessibility together. Both cost terms active on the same
    // route, which is the claim the project actually makes: a kerb and an
    // unshaded block are the same kind of constraint on the same graph.
    // Verified at 93 to 100% thermal coverage under the wheelchair and
    // low-vision profiles.
    "Junius Street to Betsy Head Park, manual wheelchair and I can't handle the heat",
    '125th Street Library to Abraham Lincoln Playground, power wheelchair, it is 95 degrees out',
    'Mott Haven Library to Governor Smith Playground, low vision and I overheat easily',
    // Heat alone.
    "Rockaway Avenue to Betsy Head Park, I can't handle the heat",
    '125th Street Library to Abraham Lincoln Playground, I have trouble with heat',
    'Mott Haven Library to Governor Smith Playground, manual wheelchair',
    "it's 95 degrees out, I'm near Penn Station with a power wheelchair. Find me a cooling center",
    'step-free route from Grand Central to Atlantic Terminal, manual wheelchair',
    'nearest cooling center to 161 Amsterdam Avenue, wheelchair',
    'cooling centers within 15 min of Yankee Stadium, I walk slowly',
    'what libraries or shelters can I reach from 2881 Third Avenue Mott Haven in 20 minutes, wheelchair',
  ];

  function pick(q: string) { queryInput.set(q); }

  /**
   * Five, then the rest behind a control.
   *
   * The list is fourteen queries long and it is the first thing under the
   * record, so the whole screen read as a menu. The five that lead are the
   * ones verified end to end most recently; everything else is still one
   * click away and nothing was deleted to make room.
   */
  const LEAD = 5;
  let expanded = $state(false);
  const shown = $derived(expanded ? EXAMPLES : EXAMPLES.slice(0, LEAD));
  const hidden = EXAMPLES.length - LEAD;
</script>

<div class="example-wrap">
  <div class="example-eyebrow">Example queries ¶</div>
  <ul class="example-list">
    {#each shown as q (q)}
      <li><button class="example-link" onclick={() => pick(q)}>{q}</button></li>
    {/each}
  </ul>
  {#if hidden > 0}
    <button
      class="example-more"
      type="button"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {expanded ? 'Show fewer' : `Show ${hidden} more`}
    </button>
  {/if}
</div>

<style>
  .example-wrap {
    padding: 16px 20px 12px;
  }

  .example-eyebrow {
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.20em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 10px;
  }

  .example-more {
    margin-top: 10px;
    padding: 6px 10px;
    min-height: 26px;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--bone);
    background: transparent;
    border: var(--rule-hair) solid var(--subtle);
    cursor: pointer;
  }
  .example-more:hover { border-color: var(--hivis); color: var(--hivis); }
  .example-more:focus-visible { outline: 3px solid var(--hivis); outline-offset: 2px; }

  .example-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .example-list li {
    font-size: 13px;
    color: var(--ink-2);
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .example-list li::before {
    content: "→";
    color: var(--muted);
    flex-shrink: 0;
  }

  .example-link {
    background: none;
    border: none;
    border-bottom: 1px dotted var(--rule);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    color: var(--ink-2);
    padding: 0;
    text-align: left;
    line-height: 1.4;
    /* Clears the 24px target minimum. These are the only way into the app for
       somebody who does not know what to type, so they should not be the
       hardest thing on the screen to hit. */
    display: block;
    min-height: 26px;
    padding: 3px 0;
  }

  .example-link:hover {
    color: var(--ink);
    border-bottom-color: var(--ink);
  }
</style>
