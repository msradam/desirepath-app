<script lang="ts">
  /**
   * The landing page, which is a pitch backdrop.
   *
   * It sits on a projector while somebody talks over it, so it is built to be
   * glanced at rather than read: a line, a pair of numbers and one button. The
   * first version was three paragraphs, a three-column definition list and a
   * limits note, which is a document. Those facts live in README.md and
   * docs/process/THESIS.md, where somebody can actually read them.
   *
   * It loads no model, no graph and no map, so it is ready the moment it is
   * served and there is never a loading bar behind the speaker.
   */

  /** Measured. tests/thermal-cases.json and the coverage build. */
  const BROWNSVILLE = { claimed: 12.8, reachable: 3.3 };
</script>

<svelte:head>
  <title>DesirePath. Close is not the same as reachable</title>
</svelte:head>

<div class="sheet">
  <header class="plate">
    <p class="wordmark">Desire<span>Path</span></p>
    <p class="subject">Accessible pedestrian routing, New York City</p>
  </header>

  <div class="stage">
    <h1>Close is not the same as reachable.</h1>

    <p class="sub">
      Walking routes to cooling centres, libraries and restrooms, over the
      sidewalk network itself. Kerb ramps and crossings are edges it routes on.
      So is heat.
    </p>

    <!-- The finding, as two numbers side by side. This is the thing to look at
         while somebody says the sentence out loud. -->
    <div class="figures">
      <div class="fig">
        <p class="fig-n">{BROWNSVILLE.claimed}<span class="pc">%</span></p>
        <p class="fig-l">the City counts as covered</p>
      </div>
      <div class="fig fig-short">
        <p class="fig-n">{BROWNSVILLE.reachable}<span class="pc">%</span></p>
        <p class="fig-l">reachable on foot, in the heat</p>
      </div>
      <p class="fig-where">Brownsville, Brooklyn &middot; NYC DEP quarter-mile claim, 24 June 2020</p>
    </div>

    <div class="actions">
      <a class="go" href="/route">Plan a walk</a>
      <a class="alt" href="/coverage?nta=BK1602">See the coverage</a>
    </div>
  </div>
</div>

<style>
  .sheet {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--slate);
    color: var(--bone);
    font-family: var(--font-sans);
  }

  .plate {
    display: flex;
    align-items: baseline;
    gap: 18px;
    padding: 12px 28px;
    background: var(--slate-2);
    border-bottom: var(--rule-hair) solid var(--subtle);
  }

  .wordmark {
    font-size: 1.15rem;
    font-weight: 900;
    letter-spacing: -0.02em;
    text-transform: uppercase;
  }
  .wordmark span { color: var(--hivis); }

  .subject {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* One block, centred, sized to the room rather than to the page. */
  .stage {
    display: grid;
    align-content: center;
    gap: 0;
    padding: 24px 28px 34px;
    overflow-y: auto;
  }

  h1 {
    max-width: 18ch;
    font-size: clamp(2.4rem, 1rem + 5.4vw, 5.6rem);
    font-weight: 900;
    line-height: 0.98;
    letter-spacing: -0.04em;
    text-wrap: balance;
  }

  .sub {
    max-width: 50ch;
    margin-top: 20px;
    font-size: clamp(1rem, 0.9rem + 0.5vw, 1.3rem);
    line-height: 1.5;
    color: var(--bone-2);
  }

  .figures {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 14px 56px;
    margin-top: 34px;
    padding-top: 22px;
    border-top: var(--rule-hair) solid var(--subtle);
  }

  .fig-n {
    font-size: clamp(2.6rem, 1.2rem + 5vw, 5rem);
    font-weight: 900;
    line-height: 0.85;
    letter-spacing: -0.045em;
  }
  .fig-n .pc { font-size: 0.42em; font-weight: 800; margin-left: 2px; }
  .fig-short .fig-n { color: var(--hivis); }

  .fig-l {
    margin-top: 10px;
    max-width: 18ch;
    font-size: 0.9rem;
    line-height: 1.35;
    color: var(--bone-2);
  }

  .fig-where {
    flex-basis: 100%;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 34px;
  }

  /* The only filled yellow on the page. */
  .go {
    padding: 15px 28px;
    background: var(--hivis);
    color: var(--slate);
    font-size: 1.1rem;
    font-weight: 900;
    text-decoration: none;
    border: 2px solid var(--hivis);
  }
  .go:hover { background: var(--hivis-2); border-color: var(--hivis-2); }
  .go:focus-visible { outline: 3px solid var(--bone); outline-offset: 3px; }

  .alt {
    display: flex;
    align-items: center;
    padding: 15px 22px;
    font-size: 1rem;
    font-weight: 700;
    color: var(--bone);
    text-decoration: none;
    border: 2px solid var(--subtle);
  }
  .alt:hover { border-color: var(--bone); }
  .alt:focus-visible { outline: 3px solid var(--hivis); outline-offset: 3px; }

  @media (max-width: 52rem) {
    .plate { flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px 16px; }
    .stage { padding: 20px 16px 28px; }
    .figures { gap: 18px 32px; margin-top: 26px; }
    .actions { flex-direction: column; align-items: stretch; }
    .go, .alt { text-align: center; justify-content: center; }
  }
</style>
