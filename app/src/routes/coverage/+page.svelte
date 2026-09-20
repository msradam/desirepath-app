<script lang="ts">
  // The coverage view, on its own route so it can be projected without the
  // routing screen competing for the room's attention.
  //
  // The neighbourhood comes from the query string (?nta=BK1602) so a demo can
  // move between the five built neighbourhoods without a rebuild. Any 2020 NTA
  // code with a coverage file works; the component names the recovery when one
  // is missing.
  import ThermalCoverage from '$lib/components/ThermalCoverage.svelte';

  const BUILT = [
    { code: 'BK1602', name: 'Brownsville' },
    { code: 'BX0101', name: 'Mott Haven' },
    { code: 'BX0602', name: 'Tremont' },
    { code: 'MN1102', name: 'East Harlem N' },
    { code: 'QN0303', name: 'North Corona' },
  ];

  let nta = $state('BK1602');

  $effect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('nta');
    if (fromUrl) nta = fromUrl.toUpperCase();
  });

  function select(code: string) {
    nta = code;
    const url = new URL(window.location.href);
    url.searchParams.set('nta', code);
    history.replaceState(null, '', url);
  }
</script>

<svelte:head><title>Quarter mile · DesirePath</title></svelte:head>

<div class="sign">
  <!-- The header is the sign's own plate: the issuing name, then the blocks
       this notice covers, as tabs you can read from the back of the room. -->
  <header class="plate">
    <a class="wordmark" href="/">
      Desire<span>Path</span>
    </a>
    <p class="subject">Quarter-mile coverage, measured on foot</p>
    <nav aria-label="Neighbourhood">
      {#each BUILT as n (n.code)}
        <button
          type="button"
          class:on={nta === n.code}
          aria-current={nta === n.code ? 'true' : undefined}
          onclick={() => select(n.code)}
        >{n.name}</button>
      {/each}
    </nav>
  </header>

  <h1 class="sr-only">
    {BUILT.find((n) => n.code === nta)?.name ?? nta}: quarter-mile cooling coverage, claimed
    against what is reachable on foot in the heat
  </h1>
  <ThermalCoverage {nta} />
</div>

<style>
  .sign {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--paper);
  }

  .plate {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 18px;
    padding: 10px 24px;
    background: var(--ink);
    color: var(--paper);
  }

  .wordmark {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 1.15rem;
    font-weight: 900;
    letter-spacing: -0.02em;
    text-transform: uppercase;
    text-decoration: none;
    color: var(--paper);
  }
  /* The second half of the name in barricade orange, which is the only place
     the wordmark uses it: the name is a route worn across something. */
  .wordmark span { color: var(--barricade); }
  .wordmark:hover { text-decoration: underline; text-underline-offset: 4px; }

  .subject {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  button {
    font: 800 0.78rem/1 var(--font-sans);
    letter-spacing: 0.02em;
    min-height: 44px;
    padding: 9px 12px;
    color: var(--paper);
    background: transparent;
    border: 2px solid var(--subtle);
    border-radius: 0;
    cursor: pointer;
  }
  button:hover { border-color: var(--paper); }
  button:focus-visible { outline: 3px solid var(--barricade); outline-offset: 2px; }
  /* The selected tab is not only orange: it is filled, and it is the only tab
     whose ink is dark. Colour never carries this on its own. */
  button.on {
    background: var(--barricade);
    border-color: var(--barricade);
    color: #121212;
  }

  @media (max-width: 62rem) {
    .plate {
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
      padding: 10px 16px;
    }
    .subject { display: none; }
    nav { gap: 2px; }
    button { padding: 8px 10px; font-size: 0.72rem; min-height: 44px; }
  }
</style>
