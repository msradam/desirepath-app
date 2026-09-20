<script lang="ts">
  /**
   * The landing page.
   *
   * One job: say what this is and get out of the way. The routing view is one
   * click from here and the coverage notice is the other.
   *
   * It carries no model, no graph and no map, so it is ready the moment it is
   * served. That matters on a phone in the heat, and it matters on a projector
   * where the first thing a room sees should not be a loading bar.
   */
  import { REFERENCE_METEOROLOGY } from '$lib/domain/thermal-constants';
  import { SUN_INFLATION_DEFAULT, SUN_INFLATION_SENSITIVE } from '$lib/domain/thermal-constants';

  /** Measured, from tests/thermal-cases.json and the coverage build. */
  const BROWNSVILLE = { claimed: 12.8, reachable: 3.3, elements: 2, km2: 2.86 };
</script>

<svelte:head>
  <title>DesirePath. Accessible routing to the places a city says are close</title>
</svelte:head>

<div class="sheet">
  <header class="plate">
    <p class="wordmark">Desire<span>Path</span></p>
    <p class="subject">Accessible pedestrian routing, New York City</p>
  </header>

  <div class="body">
    <!-- The thesis, at the top, in one sentence a person can repeat. -->
    <section class="lede">
      <h1>
        A kerb without a ramp and four hundred metres of unshaded asphalt are
        the same kind of problem. <span class="hi">This routes around both.</span>
      </h1>
      <p class="sub">
        DesirePath plans walks to public infrastructure, cooling centres,
        libraries, restrooms, senior centres, over the sidewalk network itself
        rather than the road beside it. Kerb ramps, crossings and step-free
        paths are edges it can route on. So is heat.
      </p>

      <div class="actions">
        <a class="go" href="/route">
          Plan a walk
          <span class="go-sub">type it in plain English</span>
        </a>
        <a class="alt" href="/coverage?nta=BK1602">
          See what the quarter mile really delivers
        </a>
      </div>
    </section>

    <!-- The finding. One number, stated the way it would be said out loud. -->
    <section class="finding">
      <p class="claim">
        New York says no one in its most heat-burdened neighbourhoods is more
        than a quarter mile from somewhere to cool down.
      </p>
      <p class="against">
        In Brownsville that quarter mile counts
        <strong>{BROWNSVILLE.claimed}%</strong> of the sidewalk network. Walked
        in the heat, a resident reaches
        <strong class="short">{BROWNSVILLE.reachable}%</strong>, from
        {BROWNSVILLE.elements} cooling elements across {BROWNSVILLE.km2} km².
      </p>
      <p class="cite">NYC DEP, Mayor de Blasio Expands Cool It! NYC, 24 June 2020</p>
    </section>

    <!-- What it is built on. Three facts, no icons, no cards. -->
    <section class="how">
      <dl>
        <div>
          <dt>Routes on</dt>
          <dd>
            The <strong>OpenSidewalks</strong> graph, where a sidewalk is a
            first-class edge and a kerb ramp is a node with a height. That is
            the contribution; this is a consumer of it.
          </dd>
        </div>
        <div>
          <dt>Prices</dt>
          <dd>
            <strong>Mean radiant temperature</strong> per edge, 32.5&nbsp;°C in
            deep shade to 70&nbsp;°C in open sun. A metre in full sun costs the
            router up to <strong>1.84&nbsp;metres</strong>, after Melnikov et
            al. (2022) and 408 observed path choices.
          </dd>
        </div>
        <div>
          <dt>Runs on</dt>
          <dd>
            Your device, or the machine serving this page. The routing, the
            graph and the geocoder never leave the browser, and the app says
            which engine read your sentence.
          </dd>
        </div>
      </dl>
    </section>

    <!-- The limits, on the front page rather than in a footnote. -->
    <section class="limits">
      <p>
        Radiant temperature here is a <strong>proxy, not SOLWEIG</strong>, and
        every artifact says so. Thermal survey covers five neighbourhoods,
        7.67% of the city's edges; everywhere else routes exactly as it did
        before. The field is one design hour, {REFERENCE_METEOROLOGY.air_temp_c}&nbsp;°C
        air under clear sky, and does not know what time it is.
        Sun inflation runs {SUN_INFLATION_DEFAULT} to {SUN_INFLATION_SENSITIVE}
        and is <strong>0 unless a condition is stated</strong>, so a route with
        none is identical to the one the pre-thermal router produced.
      </p>
    </section>
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

  .body {
    overflow-y: auto;
    padding: 0 28px 40px;
  }

  /* ── The thesis ────────────────────────────────────────────────────────── */
  .lede {
    max-width: 62rem;
    padding: 44px 0 34px;
  }

  h1 {
    max-width: 24ch;
    font-size: clamp(1.9rem, 1.1rem + 3.1vw, 3.6rem);
    font-weight: 900;
    line-height: 1.04;
    letter-spacing: -0.035em;
    text-wrap: balance;
  }
  .hi { color: var(--hivis); }

  .sub {
    max-width: 58ch;
    margin-top: 20px;
    font-size: clamp(0.98rem, 0.88rem + 0.4vw, 1.2rem);
    line-height: 1.55;
    color: var(--bone-2);
  }

  /* ── The one click ─────────────────────────────────────────────────────── */
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 12px;
    margin-top: 30px;
  }

  /* The primary action is the only filled yellow on the page, so there is
     never a question which one it is. */
  .go {
    display: grid;
    gap: 2px;
    padding: 14px 22px;
    background: var(--hivis);
    color: var(--slate);
    font-size: 1.05rem;
    font-weight: 900;
    letter-spacing: 0.01em;
    text-decoration: none;
    border: 2px solid var(--hivis);
  }
  .go-sub {
    font-family: var(--font-mono);
    font-size: 0.64rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    opacity: 0.85;
  }
  .go:hover { background: var(--hivis-2); border-color: var(--hivis-2); }
  .go:focus-visible { outline: 3px solid var(--bone); outline-offset: 3px; }

  .alt {
    display: flex;
    align-items: center;
    padding: 14px 20px;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--bone);
    text-decoration: none;
    border: 2px solid var(--subtle);
  }
  .alt:hover { border-color: var(--bone); }
  .alt:focus-visible { outline: 3px solid var(--hivis); outline-offset: 3px; }

  /* ── The finding ───────────────────────────────────────────────────────── */
  .finding {
    max-width: 62rem;
    padding: 26px 0 26px 22px;
    border-left: var(--rule-heavy) solid var(--hivis);
  }

  .claim {
    max-width: 54ch;
    font-size: clamp(1.05rem, 0.92rem + 0.5vw, 1.35rem);
    font-weight: 700;
    line-height: 1.35;
  }

  .against {
    max-width: 56ch;
    margin-top: 12px;
    font-size: clamp(0.95rem, 0.88rem + 0.3vw, 1.1rem);
    line-height: 1.5;
    color: var(--bone-2);
  }
  .against strong { color: var(--bone); font-weight: 800; }
  .against strong.short { color: var(--hivis); }

  .cite {
    margin-top: 10px;
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* ── How ───────────────────────────────────────────────────────────────── */
  .how {
    max-width: 78rem;
    margin-top: 34px;
    padding-top: 26px;
    border-top: var(--rule-hair) solid var(--subtle);
  }

  .how dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
    gap: 26px 40px;
  }

  .how dt {
    font-family: var(--font-mono);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--reach);
  }

  .how dd {
    margin-top: 8px;
    font-size: 0.92rem;
    line-height: 1.55;
    color: var(--bone-2);
  }
  .how dd strong { color: var(--bone); font-weight: 700; }

  /* ── Limits ────────────────────────────────────────────────────────────── */
  .limits {
    max-width: 72rem;
    margin-top: 30px;
    padding-top: 20px;
    border-top: var(--rule-hair) solid var(--subtle);
  }
  .limits p {
    max-width: 86ch;
    font-size: 0.82rem;
    line-height: 1.6;
    color: var(--muted);
  }
  .limits strong { color: var(--bone-2); font-weight: 700; }

  @media (max-width: 52rem) {
    .plate { flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px 16px; }
    .body { padding: 0 16px 32px; }
    .lede { padding: 28px 0 24px; }
    .actions { flex-direction: column; align-items: stretch; }
    .finding { padding-left: 16px; }
  }
</style>
