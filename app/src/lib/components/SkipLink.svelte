<script lang="ts">
  let { target = '#content' }: { target?: string } = $props();
</script>

<!--
  Skip link. First focusable element in the page.
  Visually hidden until focused; jumps keyboard users past repeated navigation.
  WCAG 2.4.1 Bypass Blocks (Level A).
-->
<a
  href={target}
  class="skip-link"
>
  Skip to main content
</a>

<style>
  .skip-link {
    position: absolute;
    top: -9999px;
    left: 6px;
    z-index: 9999;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 8px 16px;
    /* Stencil black on barricade orange: the sign's own emergency pairing, and
       the only combination in the palette that holds at this size. */
    background: var(--barricade);
    color: #121212;
    font-weight: 800;
    font-size: 0.875rem;
    border-radius: 0;
    text-decoration: none;
    white-space: nowrap;
  }

  .skip-link:focus-visible {
    top: 0;
    outline: 2px solid var(--bg);
    outline-offset: -4px;
  }
</style>
