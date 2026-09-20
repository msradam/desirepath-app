# HANDOFF

`ariadne-thermal` extends [`ariadne-nyc`](https://github.com/msradam/ariadne-nyc) with a
thermal cost layer, so the pedestrian router optimises heat exposure alongside distance
and accessibility.

The headline is one comparison. New York's Cool It! programme promises that "no New
Yorker in the most heat-burdened communities is more than 1/4 mile away from an outdoor
cooling element" (NYC DEP, 24 June 2020). "Away from" is a straight line. Measured
against what a heat-burdened pedestrian can actually walk to on the OpenSidewalks graph,
the claim covers between 9 and 43 percentage points more of a neighbourhood's sidewalk
network than the network delivers, and one of the five neighbourhoods built here has no
outdoor cooling element at all.

For the demo click path, see `DEMO.md`.

---

## 1. The quarter-mile comparison

Strict reading: spray showers and misting stations only, which is what the Cool It!
announcement means by "outdoor cooling element". Shares are of the walkable sidewalk
network inside the neighbourhood boundary, at the sensitive end of the observed
behavioural coefficient range.

| Neighbourhood | Elements | As the crow flies | Walking | Walking in the heat | Gap |
|---|---|---|---|---|---|
| East Harlem North | 18 | 79.0% | 60.5% | 35.9% | **43.1 points** |
| Mott Haven, Port Morris | 9 | 56.8% | 42.9% | 21.4% | **35.4 points** |
| Tremont | 8 | 56.1% | 49.0% | 31.6% | **24.4 points** |
| Brownsville | 2 | 12.8% | 7.9% | 3.3% | **9.4 points** |
| North Corona | **0** | none | none | none | the claim covers nothing |

In area: East Harlem North's quarter mile claims 1.92 km² and delivers 0.87 km² to a
heat-burdened resident. Brownsville's claims 0.37 km² and delivers 0.10 km².

Including drinking fountains, which the same programme counts but which are hydration
rather than cooling, Brownsville goes to 86.4% claimed and 56.4% reachable in heat, a
30.0 point gap. Both readings are computed; the view leads with the strict one because
counting the 102 drinking fountains in the Brownsville bounding box would flatter the
claim by a factor of six.

Reproduce: `npm run route -- coverage BK1602`

---

## 2. Thermal routing

`npm run route -- thermal-suite`, nine cases, no failures.

| Case | Shortest | Detour | Mean MRT | Change |
|---|---|---|---|---|
| East Harlem North | 1405 m | +22 m (+1.6%) | 59.2 to 44.6 °C | **−14.5 °C** |
| Mott Haven | 1964 m | +2 m (+0.1%) | 56.1 to 50.1 °C | −5.9 °C |
| Brownsville, cross-neighbourhood | 1627 m | +8 m (+0.5%) | 54.8 to 50.2 °C | −4.6 °C |
| Brownsville, station to park | 1858 m | +20 m (+1.1%) | 51.3 to 48.5 °C | −2.8 °C |
| Penn Station to Grand Central | 1716 m | **+0 m** | no MRT data | 0.0 °C |
| Union Square to Washington Square | 1004 m | **+0 m** | no MRT data | 0.0 °C |

**The last two rows matter as much as the first.** Where no thermal signal exists the
heat-aware route is byte-identical to the shortest one, because an unsurveyed edge
carries no `mrt` attribute rather than a default of zero. That guarantee is asserted in
`router/tests/thermal.rs` and in `app/tests/unit/thermal.test.ts`, and it is what lets
the thermal layer ship switched off by default without changing any existing behaviour.

Comparable published systems: Cool Routes reports up to −3.8 °C for detours under 3%;
Kolaxidis et al. (2025) 16 to 29% less solar exposure for about 3%; Wen et al. (2025)
8.8% less sun for 1.3%. These numbers sit inside that range rather than above it.

### How heat is costed

`cost = length × (1 + (β − 1) × exposure)`, where exposure interpolates the edge's mean
radiant temperature between a shade anchor (33.0 °C) and a sun anchor (61.8 °C) computed
from the radiation budget at the reference meteorology.

β comes from Melnikov et al. (2022), *Scientific Reports* 12:2441, who estimate it from
408 observed pedestrian path choices: population mean 1.16, individual values to 1.84.
Basu et al. (2024), *Cities* 155:105435, revealed preference from GPS traces in Boston,
converts to about 0.63 in the same units. `config/condition-map.yaml` places conditions
on that measured range and states in as many words that the scale is empirical while the
placement of a given condition on it is a design judgement.

Every cost parameter is derived, not chosen. The derivation prints:
`uv run python -m pipeline.thermal.thresholds`

### Criterion 2, the card changes the route

Verified live, offline, on `Rockaway Avenue to Betsy Head Park`:

- No condition stated: consequence panel reads *"Heat: not priced"*, route 1858 m.
- Tick **Reduced ability to sweat**: panel changes before anything routes to *"Heat:
  priced. Sun inflation 0.84: a metre in full sun is costed as 1.84 metres. Continuous
  exposure capped at 7 minutes."* Route becomes 1877 m, mean MRT 51.3 → 48.5 °C, peak
  67.0 → 63.5 °C.

**Caveat for anyone demoing it:** the route strip rounds both to "25 min · 1.2 mi", so
the change is real but not visible on screen. Say the numbers; do not point at the strip.

Raising β from 0.16 to 0.84 does not change the route further on this pair. The route
flips once to the best available shaded alternative and then stays there. That is
expected, and it means the coefficient controls *whether* a detour is taken, not how
elaborate it gets.

---

## 2b. The interface, rebuilt as DesirePath

The project was renamed DesirePath and the interface rebuilt. The palette went through two
rounds: a light sign-white version was rejected, and the shipped one is a single saturated
slate field running edge to edge with the map knocked out of it. Bone for what is said,
high-visibility yellow for the shortfall and nothing else, cold cyan for what is reachable.
Overpass throughout, which descends from the Highway Gothic on municipal signage, and it is
self-hosted, which also took the Google Fonts fetch off the query path.

Every ink clears WCAG AA against every ground it is used on, computed rather than eyeballed
before the values were committed; the worst pair is `--muted` on the raised ground at
4.80:1. `--subtle` is border-only and is documented in `app.css` as never for type. The
yellow and the cyan are separated in relative luminance, 0.61 against 0.40, so they do not
collapse into one another on a washed-out projector. A sweep over every rendered text node
on both screens returns zero failures.

Two screens now, and only two. `/coverage` is the notice: the neighbourhood and the gap
figure on one line, the map full bleed, the three readings stamped at the foot with what
each one is down from. The DEP claim is attribution and sits with the rest of the
provenance at the foot, at the size attribution is; it was briefly set across the top at
display size, which made the screen look like it was quoting rather than measuring. `/` is the routing view, which kept its work and
gained the same plate. The brand rail, the session strip and the feed diagnostics are gone,
along with `WayfindingStrip.svelte`, `SessionBar.svelte`, `FeedStatus.svelte` and
`stores/network.ts`.

Nothing on either screen rides on colour alone. Every fill that carries meaning carries a
dash or a hatch as well, in the map layers and in the key, because this gets projected into
a bright room. Audit at 1440 and 390: no text under 4.5:1, no target under 44px except
MapLibre's own attribution links, no horizontal scroll, and a heading on a screen that had
none. The design detector returns one finding, a 3px black rule dividing the query column
from the map on the routing view; it is a structural divider in a world built from heavy
rules, not the accent tab the rule is written against.

Three real defects surfaced during the rebuild and were fixed: `fitBounds` ran against a
container with no height yet and silently landed the map on the whole tri-state area; the
dispatch control wrapped one option onto a second row at every width worth supporting; and
the zero-element state stretched into a sheet of empty rule instead of sitting at the size
of its content.

The direction contract is in `.impeccable/surfaces/`, product truth in `PRODUCT.md`, and
the argument the whole thing exists to make is in `THESIS.md`.

## 2c. The confirmation card was removed, and what that costs

The original brief made one thing non-negotiable: a profile is proposed and then confirmed
on an editable card, so that a silently dropped constraint is impossible. That card is
gone. It was removed on the user's explicit instruction after they found it unusable: it
rendered as a full-height wall of form inside a column with `overflow: hidden` and no
scrollable child, so everything below the fold was clipped with no way to reach it.

**This is a real weakening of the guarantee and should not be described as anything else.**
A query now routes on submit. What stage 1 read out of the sentence is disclosed after the
fact, in the block above the route: the tool it dispatched to, the conditions it read, and
whether heat was priced. That block is not behind a control and says in as many words that
the route was already planned on those values.

What is lost is the part that mattered. Before, a condition the model failed to read could
be added by the person before anything routed, and the route changed as a result. Now a
missed condition produces a route planned without it, and the person finds out afterwards.
Given the measured over- and under-generation on `conditions` (under-generation is the
dangerous direction: "I can't handle the heat" once produced `conditions: []`), this will
happen.

The two end-to-end tests that asserted the old guarantee, "nothing routes until the card is
accepted" and "editing the card changes the route", were deleted rather than quietly left
failing. `tests/e2e/surfaces.spec.ts` carries a note saying so at the point they used to
be. The coverage-view tests in that file still run.

If the confirmation step comes back, the thing to rebuild is not the old card. It is a
compact strip that shows only the fields the model actually filled in, with the full form
behind a control, in a container that scrolls.

## 3. Extraction, measured against the real model

17 golden fixtures. The numbers below were measured in a real browser against
Granite 4.0 1B on WebGPU, which was the only way to run stage 1 at the time.

**Stage 1 now runs against Granite 4 in Ollama on the same machine**, through the same
`LLMAdapter` interface and the same generated schema. Ollama compiles the schema to GBNF
and masks the sampler with it, so the constraint is the same guarantee by the same
mechanism. `npm run extract` runs the whole battery from node in about 30 seconds with no
browser and no GPU contention; the WebGPU path is still in the repo and still works, at
`?llm=webgpu`. The sentence goes to localhost either way and the privacy log says so in
those words rather than claiming nothing leaves the browser.

### The guarantee holds

**Schema validity was 100% across every run and every language.** That is a property of
the decoder, not of the model: XGrammar compiles a JSON Schema generated from
`config/condition-map.yaml` and masks the logits, so a condition term the map does not
define is unreachable rather than merely discouraged.

Decoder refusals, measured over 102 extractions before the retry shipped: **3.92%**
(4 of 102), all `grammar matcher rejected the newly sampled token`. Transient, not
fixture-bound: every refused fixture succeeded on other repetitions, with no correlation
to language (3 English, 1 Spanish), sentence length (24 to 77 characters) or adversarial
class. Median 3.35 s, p95 4.46 s.

A single counted retry now ships. It is capped at one, every retry increments
`decoderStats.retries`, and failures after the retry increment
`decoderStats.refusalsAfterRetry`, because a silent retry would make the guarantee
unmeasurable.

| | Extractions | First-attempt refusals | Failures after retry |
|---|---|---|---|
| Before the retry shipped | 102 | 4 (**3.92%**) | n/a |
| After the retry shipped | 102 | 1 (**0.98%**) | **0 (0.00%)** |
| Combined | 204 | 5 (2.45%) | 0 of 102 |

Every first-attempt refusal was rescued by the single retry. That is consistent with the
refusals being transient rather than fixture-bound, which is what the pre-retry breakdown
already suggested.

The accurate claim is **"valid or refuses, never invalid"**, and after one retry the
observed refusal rate is zero in 102 extractions.

### The accuracy is poor, and that is the finding

**3 of 17 fixtures exactly right.** Field-level misses across 51 deterministic runs:

| Field | Wrong in |
|---|---|
| `intent` | 33 of 51 runs (65%) |
| `resource_types` | 18 of 51 (35%) |
| `conditions` | 15 of 51 (29%) |
| `destination` | 6 of 51 (12%) |
| `max_minutes` | 3 of 51 (6%) |

**`intent` is worse than a constant predictor.** The fixtures split
plan_route 8, find_comfort 7, find_reachable 2. Always answering `plan_route` would score
47.1%. The model scores 35.3%. Uniform random over three classes would score 33.3%.

The failure is systematic, not noisy. Across all 17 fixtures the model predicted
`find_reachable` 11 times and `find_comfort` 6 times, and **never once predicted
`plan_route`**, which is the most common true class.

### Why intent was wrong, and what replaced it

The cause was in the schema, not in the model. XGrammar generates keys in the order the
schema declares them, and `intent` was declared first. Reading the emitted key order back
off a live extraction shows it directly:

```
emittedKeyOrder: ["intent","origin","destination","resource_types",
                  "conditions","max_minutes","for_someone_else"]
raw: {"intent": "find_reachable", "origin": "Penn Station",
      "destination": "Grand Central", ...}
```

The model committed to `find_reachable` before `destination` existed in its context. It
was classifying the sentence before it had read the sentence out into the form, and the
only two slots carrying evidence for the classification, `destination` and `max_minutes`,
were both generated afterwards. A field ordered that way cannot be better than a guess.

`intent` is now gone from the schema. Which of the three router tools runs is derived
from the slots by `app/src/lib/domain/dispatch.ts`: a named destination routes to it, no
destination and no clock finds the nearest, no destination with a clock draws what is
reachable. The mapping reproduces the expected tool for all 17 fixtures with no inference
at all, asserted in `app/tests/unit/extraction.test.ts`, so dispatch correctness is now a
property of the slots rather than a prediction to be scored.

The confirmation card still shows which tool was chosen and still lets the user change it,
because a derived answer can be wrong about an ambiguous sentence even when it is never
wrong about the slots it reads. The card says which case applies: chosen from the form, or
changed by you.

### Two failure modes, both caught by the card

**Over-generation.** "I have a spinal cord injury and I don't sweat" produced
`cardiovascular_strain, impaired_sweating, low_vision`. Two of those were never stated.
"I'm diabetic and pregnant" produced four conditions, three of them spurious (diabetes
itself is correctly unemittable, being outside the vocabulary).

**Under-generation.** "I can't handle the heat. Nearest library from Sutter Avenue."
produced `conditions: []`. The constraint vanished entirely, and the route would have
been indistinguishable from one requested by somebody who said nothing.

Both are exactly why nothing routes until the user accepts the card. This is not a
theoretical safeguard: during the offline verification the model set
`intent: find_reachable`, the route came back "0 places", and correcting one radio button
turned it into a real route.

### The multilingual gap

| Language | Fixtures | Schema-valid | Exactly right |
|---|---|---|---|
| English | 12 | 100% | 2 |
| Spanish | 3 | 100% | 1 |
| Bengali | 1 | 100% | 0 |
| Haitian Creole | 1 | 100% | 0 |

Bengali and Haitian Creole recovered a partial origin and nothing else. Both are
household languages in the highest Heat Vulnerability Index neighbourhoods. The fixtures
were not tuned to improve this.

---

## 4. Criterion 4: the null result on thermally priced transit waits

A wait has a duration and a location, and that location has a radiant environment. The
router prices it as `wait_seconds × thermal_load(platform_mrt)`. Platform class comes
from MTA Subway Stations (`39hk-dx4f`): 283 underground, 27 open-air sampled from the
grid, 186 open-air outside coverage. An exposed elevated platform in Brownsville samples
62 to 63 °C; underground is an assumed 37 °C.

**It does not change a mode decision at any coefficient in the observed range.**

Swept: `sun_inflation` 0.16, 0.40, 0.63 and 0.84, which spans the Melnikov population
mean to the observed individual maximum, across every ordered pair of transit, park and
library POIs within each of the five neighbourhoods at 500 to 2500 m separation,
departing 15:00. No mode changed and no boarding station changed.

**Why, and what would have to be true for it to flip.** At 15:00 on a weekday the lines
serving these neighbourhoods run every two to four minutes, so the wait being priced is
1 to 4 minutes. At the population mean that is about 20 thermal seconds of penalty; at
the most sensitive coefficient about 100. The walk legs are kilometres, and their
thermal weighting dominates by an order of magnitude.

A flip needs one of:

- **Long headways.** Off-peak, late night, or a weekend service pattern, where a 12 to 20
  minute wait is realistic. The grid is currently built only for 15:00, so this cannot be
  tested without building an evening layer.
- **A short walk alternative.** Under about 600 m, where the walk's own thermal cost stays
  small. The router currently short-circuits to walk-only below 600 m without consulting
  transit at all, so that branch would need changing first.
- **A much hotter platform than its surroundings.** The elevated-platform exposure floor
  already lifts elevated platforms toward the grid maximum, but a measured platform
  temperature rather than a sampled ground-level one would widen the gap.

An earlier build did show a mode flip, driven into the underground system by heat. That
came from a cost function whose worst case was 3.92× plain distance, which the literature
does not support. When the coefficient was corrected to the measured 1.16, the flip
disappeared. **The honest conclusion is that thermally priced waits matter where headways
are long, and NYC peak headways are short.** No coefficient was tuned to recover it.

---

## 5. Air quality: analysis, not a routed layer

NYCCAS was investigated and **deliberately not wired into the cost function**. The
analysis stands on its own and corrects a premise.

**The correction.** The working assumption was that NO₂ and black carbon are
tailpipe-proximate, falling off within metres of the curb, and that this is precisely the
resolution an OpenSidewalks graph works at, where the two sides of a street are separate
edges. **That is not supported by this dataset.** NYCCAS Air Pollution Rasters
(`q68s-8qxv`, verified live) are **300 m** (984 US ft), 157 × 156 cells for the entire
city, EPSG:2263. Both sides of a street, and several parallel streets, fall in one cell.
Any routing on it would be corridor-scale, not curbside.

**What survives, measured on NYC's own data.** Sampling all 1,366,756 edge midpoints
against the year-15 annual-average rasters:

| Pollutant | Within-Brownsville range | As % of citywide median | Citywide edge range |
|---|---|---|---|
| NO₂ | 3.72 ppb | **23.1%** | 7.83 to 28.41 ppb |
| Black carbon | 0.13 | **24.1%** | 0.35 to 1.58 |
| PM2.5 | 0.71 | **10.7%** | 5.95 to 8.77 |

NO₂ and black carbon vary about **2.2× more** than PM2.5 within a single neighbourhood.
So **excluding PM2.5 from any future cost function is now justified empirically rather
than by citation**: on this city's own surfaces, PM2.5 is close to uniform at the scale a
pedestrian route can act on, and routing on it would move the number without moving the
exposure.

**Seasonal inversion, worth recording:** heat peaks in summer while NO₂ and PM2.5 rise in
winter, partly because building boilers burn oil and gas for heat and hot water. One
exposure framework, two seasons, the same graph.

**Real-time PM2.5** is available hourly from NYCCAS street-level monitors, one of which is
in Mott Haven, one of the five built neighbourhoods. It is **not** wired in and should not
be wired into the query path: it would break the offline guarantee. It belongs in the same
class as the MTA SIRI elevator call, a boot-time fetch, and is left unimplemented.

---

## 6. What is proxied, and its tier

**Mean radiant temperature: `tier: proxy`.** Labelled in every artifact, every CLI line
and the comparison view itself.

Same as SOLWEIG: the governing equation. Tmrt from the six-directional radiant flux of
Höppe (1992) with the published angular factors for a standing body (0.06 up and down,
0.22 per side, 0.28 cylinder) and absorption coefficients (0.70 shortwave, 0.97
longwave), inverted through Stefan-Boltzmann. Clear-sky irradiance from Kasten and
Czeplak (1980), direct and diffuse split from Erbs et al. (1982), sky emissivity from
Prata (1996).

Different from SOLWEIG: the geometry. Extruded building footprints at 4 m rather than a
LiDAR digital surface model at 1 m, tree crowns from the street tree census rather than a
canopy model, clear sky, one hour, no wind, no humidity, no anisotropic sky.

Validation: building shade buys **28.8 K** here. Middel et al. (2021) measured 22.8 to
30.9 K from urban form across 1,988 samples; Du et al. (2020) report 28.8 K in Harbin.
Sunlit 61 to 66 °C and shaded 33 to 38 °C sit inside what Li et al. (2023) map for
Philadelphia, the closest published humid-continental analogue.

**Underground platform temperature: `tier: assumed`.** A single constant of 37 °C stands
in for every underground platform. No measured NYC platform temperatures were available.
One constant in `pipeline/thermal/stops.py`; replacing it changes nothing else.

**Wind: not modelled at all.** The MRT budget has no convective term. This is the single
largest physical omission and is why UTCI is the top next step.

**Air quality vintage: NYCCAS year 15 annual average, 300 m.** Analysis only, not routed.

**Resident counts: absent, not estimated.** No 2020 population by 2020 NTA was available
cheaply, so the comparison reports network share and area and claims no number of people.
Area is derived from node share assuming even node density, labelled where it appears.

**Coverage: 7.66% of the city's edges.** Five neighbourhoods out of roughly 200.
Everything outside them routes exactly as it did before.

---

## 7. The three highest-value next steps

### 1. Cut the remaining over-generation on `resource_types` and `conditions`

**Motivated by:** the intent field, which was the sharpest result in the project, has been
removed rather than improved on, and the reason is above: it was decoded before the
evidence for it existed. Deleting it took the worst field out of the schema without
costing anything, because the tool it selected is derivable from two slots the model was
already filling in.

What remains is over-generation on the two array fields. The model volunteers resource
types nobody asked for and conditions nobody stated, which is the failure mode the card
exists to catch but should not have to catch this often. The same reasoning that fixed
intent may apply: both arrays are generated before the model has committed to anything
about the sentence, and a schema that ordered the free-text slots first might anchor them.
That is a cheap experiment now that stage 1 runs from node in under 30 seconds.

### 2. Swap the routed cost from MRT to UTCI

**Motivated by:** wind is entirely unmodelled, and the current cost is radiation-only.

UTCI takes air temperature, relative humidity, mean radiant temperature and 10 m wind and
returns an equivalent temperature, derived from the Fiala multi-node thermoregulation
model coupled to an adaptive clothing model (Bröde et al., 2012). The hardest input is
already computed, and `thermofeel` is already a dependency and already used to derive the
thresholds. It brings wind in physiologically rather than as an invented term, and it
**covers cold stress**, which makes the project year-round rather than a July product:
wind chill routing in February falls out of the same equation with no new model.

It was cut from this build for a specific reason worth preserving: with **uniform station
wind**, UTCI is a monotone transform of MRT at fixed air temperature and humidity, so the
routes barely move. What it buys is interpretability (the official stress category
boundaries apply directly, with no inversion) and cold stress. Neither survives a
five-minute demo. It becomes genuinely valuable the moment wind varies spatially, which
means a street-canyon sheltering term from the building heights already extruded. That
term must be labelled `tier: proxy` exactly as MRT is: every UTCI paper worth citing
derives pedestrian-level wind from CFD, and uniform station wind is the honest baseline
rather than something to imply otherwise.

### 3. Measure what is currently assumed

Two of the weakest numbers stand in for measurements that could exist.

**Underground platform temperature** needs a sensor and a summer. It is currently one
assumed constant driving the entire underground half of the transit wait model.

**A New York route-choice coefficient.** β currently comes from 46 university students in
Singapore, cross-checked against GPS traces in Boston. The population this router is
aimed at is older, sicker and less acclimatised than either. A stated-preference
instrument run in Brownsville would replace the single weakest link in the argument.

---

## 8. Reproducing it

```bash
git clone <this repo> && cd ariadne-thermal
./scripts/fetch-base-data.sh          # base artifacts and app/static links
uv venv && uv pip install -e .
uv run python -m pipeline.thermal build            # five neighbourhoods, about 90 s
uv run python -m pipeline.thermal.profiles         # derived cost parameters
uv run python -m pipeline.thermal.grammar          # extraction schema
cd router && cargo build && wasm-pack build --target web --out-dir pkg && cd ..
cd app && pnpm install
npm run route -- thermal-suite
npm run route -- coverage BK1602
cd .. && ./scripts/setup-model.sh                  # only for the model stages
```

The base pedestrian graph comes from the deployed ariadne-nyc HuggingFace Space rather
than a 60 to 90 minute Overpass rebuild. The OpenSidewalks v0.3 borough splits come from
the `opensidewalks-nyc` release `v0.3.1-nyc.1`, which is already validator clean. Neither
is rebuilt here, on purpose.

**The dev server cannot load the model.** `optimizeDeps.exclude` on `@mlc-ai/web-llm`
means Vite serves it unbundled and the TVM runtime import is not wired, so
`WebAssembly.instantiate` fails. Anything needing the model runs against a production
build served by `app/scripts/serve-build.mjs`, which also sets the COEP and COOP headers
cross-origin isolation requires and which `vite preview` does not.

---

## 9. Pre-existing breaks found and fixed in the base repo

Recorded because they were all invisible until something forced them into the light.

- **The Rust router did not compile.** The upstream "Polish: typography, prose" pass
  sentence-cased six Rust keywords in `profile.rs` and `routing.rs`.
- **A unit test contradicted its own shipped profile.** `cost.rs` asserted that a crossing
  without a confirmed curb ramp is impassable for `manual_wheelchair`, but the profile
  charges 3× instead, deliberately, so that gaps in NYC's curb-ramp survey do not strand
  wheelchair users.
- **`app/static/examples` and `app/static/pkg` were absolute symlinks** into
  `/Users/amsrahman/ariadne-nyc/experiments/`, a path that only ever existed on the
  original author's machine, and `static/output` was missing entirely. svelte-check
  reported 13 errors because of it.
- **`npm run test` collected the Playwright e2e specs under Vitest** and failed on every
  one.
- **`@mlc-ai/web-llm` was pinned `^0.2.82`** and the caret resolved forward to 0.2.85,
  whose TVM runtime ABI the published Granite model library cannot load. The app booted
  into its "model unavailable" path, which enables the search bar, so nothing looked
  obviously broken.
- **Playwright passed `--use-vulkan=swiftshader` in headed mode**, forcing software
  rendering on a machine with Metal. The model then loaded so slowly that runs looked hung
  rather than slow.

---

## 10. One claim to phrase carefully

The roadmap includes a resident client calling a city-hosted inference server.

**"No PII" is only true if the free text never leaves the device.** If the server performs
extraction, the raw sentence crosses the wire, and the raw sentence is exactly where the
health condition and the home address are.

The accurate claim, and the one to make on stage:

> Routing, destinations and the graph stay local. Nothing about the query or the
> destination leaves the browser.

That is verified: the offline test cut the network mid-session and the full pipeline,
model inference included, still produced a route.

---

## 11. Numbers that will be quoted, verified

- **Heat deaths, NYC: about 500 a year.** NYC DOHMH Heat-Related Mortality Report:
  525 annually for 2018 to 2022, of which about 5 are heat-stress deaths and about 520
  heat-exacerbated.
- **PM2.5 deaths, NYC: about 2,000 a year.** NYC DOHMH Environment & Health Data Portal:
  "current overall PM2.5 levels from all sources contribute to 2,000 deaths ... each
  year". Traffic specifically contributes about 320.

Two corrections to figures that were circulating:

- It is **2,000, not "more than 2,000"**. An older DOHMH figure of 3,000+ exists; the
  current portal figure is 2,000, and quoting the higher one without the vintage would be
  wrong.
- **"Roughly one in twenty NYC deaths" is not supported.** Against roughly 52,000 annual
  deaths citywide, 2,000 is about 3.8%, closer to one in twenty-six. Do not use the one in
  twenty framing.

The pairing is still the right framing, and is stronger for being accurate: air pollution
is the larger killer and the one routing can do least about, at 300 m corridor scale;
heat is the smaller number where routing helps most, at 4 m. Both halves are true.

---

## Provenance

Every dataset identifier was verified live against its API during the build, not recalled.
Licences, the one added dependency and the alternatives rejected are in
`DEPENDENCIES.md`. Sources and caveats for every cost parameter are in
`config/condition-map.yaml` and print from
`uv run python -m pipeline.thermal.thresholds`.
