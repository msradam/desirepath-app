<script lang="ts">
  // The reachability comparison view, on its own route so it can be projected
  // without the app shell competing for the room's attention.
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

<svelte:head><title>Quarter mile · Ariadne</title></svelte:head>

<nav aria-label="Neighborhood">
  {#each BUILT as n (n.code)}
    <button type="button" class:on={nta === n.code} onclick={() => select(n.code)}>{n.name}</button>
  {/each}
</nav>

<ThermalCoverage {nta} />

<style>
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 12px 16px 0;
    background: var(--bg);
  }
  button {
    font: 500 12px/1 var(--font-sans);
    letter-spacing: 0.02em;
    padding: 9px 13px;
    color: var(--ink-2);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 2px;
    cursor: pointer;
  }
  button:hover { background: var(--surface); color: var(--ink); }
  button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  button.on {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--primary-on);
  }
</style>
