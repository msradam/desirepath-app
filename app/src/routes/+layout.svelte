<script lang="ts">
  // The shell is deliberately almost nothing.
  //
  // DesirePath is two screens: the coverage notice and the routing view. Each
  // carries its own header, because each is projected or opened on its own and
  // a persistent brand rail and session strip were furniture competing with the
  // one thing the room is supposed to read. The diagnostics they carried live
  // on the screens that own them.
  import '../app.css';
  import SkipLink from '$lib/components/SkipLink.svelte';

  let { children } = $props();
</script>

<SkipLink />
<main id="content" tabindex="-1">
  {@render children()}
</main>

<style>
  main {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    outline: none;
    background: var(--paper);
  }
</style>
