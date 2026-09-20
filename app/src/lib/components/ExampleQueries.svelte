<script lang="ts">
  import { queryInput } from '$lib/stores/query-log';

  // Heat-showing examples first. The thermal model covers five neighbourhoods,
  // and all five of the originals ran outside every one of them, so the first
  // thing anybody clicking down this list saw was "not surveyed". The
  // originals are kept below, because the empty state is worth showing on
  // purpose.
  const EXAMPLES = [
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
</script>

<div class="example-wrap">
  <div class="example-eyebrow">Example queries ¶</div>
  <ul class="example-list">
    {#each EXAMPLES as q}
      <li><button class="example-link" onclick={() => pick(q)}>{q}</button></li>
    {/each}
  </ul>
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
