# PLAN

Extend `ariadne-nyc` with a thermal cost layer, so the pedestrian router optimizes heat
exposure alongside distance and accessibility. One session, 3 hour timebox.

The headline result is a single comparison. NYC's Cool It! standard says residents of
heat-burdened neighborhoods should be within a quarter mile of an outdoor cooling element.
That is a straight-line radius drawn on a map. This project renders it against what a heat-
and mobility-constrained pedestrian can actually reach on the OpenSidewalks graph, and
quantifies the gap.

---

## Orientation: what was read, and what is being reused

| Repo | Read | Reused |
|---|---|---|
| `ariadne-nyc` | README, ARCHITECTURE, METHODOLOGY, all of `router/src`, `pipeline/utils/export_binary.py`, the adapter and service layer | Everything. This repo is a clone of it at `93f7013` with the remote removed. |
| `opensidewalks-nyc` | README, release manifest | The OSW v0.3 artifact itself, release `v0.3.1-nyc.1`. Validator clean against `python-osw-validation` 0.4.4, 3,374,261 features. Per borough splits, not the 2 GB citywide file. |
| `riprap-nyc` | `riprap/core/pebbles/schema.py`, `app/stones/*` | The discipline, not the code: a `Provenance` block per source, and the epistemic tier chip (`empirical`, `modeled`, `proxy`, `synthetic`). The thermal layer carries a tier, so the UI can say out loud that it is a proxy and not SOLWEIG. |
| `dream-meridian` | `tool_grammar.gbnf`, WRITEUP, INSTALL | The posture. GBNF constrains tool calls at the token level in llama.cpp. The equivalent here is XGrammar, which the existing runtime already ships. |

### Two findings that shape everything below

`router/src/cost.rs` evaluates a data driven rule tree, not compiled logic. A profile declares
`impassable_if`, a `base` attribute, and a list of conditional `multipliers`. So a thermal
penalty is a profile JSON edit, **provided the edge carries a thermal attribute**. The only
Rust change needed is teaching the binary loader to read one more byte.

`@mlc-ai/web-llm@0.2.82` already depends on `@mlc-ai/web-xgrammar@0.1.27` and exposes
`response_format: { type: 'grammar', grammar: '<EBNF>' }` on the chat completion call.
Grammar constrained decoding therefore costs **zero new dependencies**. Verified by unpacking
the published tarball and reading `lib/openai_api_protocols/chat_completion.d.ts`.

---

## Architecture

The three stage split is settled and is preserved exactly. Only stages 1 and 3 touch a model.

1. **Natural language to profile object.** Structured extraction, schema masked at the logit
   level by XGrammar. The grammar is generated from the profile schema at build time and
   written to `app/src/lib/grammar/profile.ebnf`. If the constrained path is ever bypassed,
   the extraction records `constrained: false` and the harness fails the run loudly.
2. **Profile to route.** Deterministic Dijkstra over the existing WASM graph, and RAPTOR over
   the existing Minotor timetable. No model anywhere in this stage.
3. **Route to explanation.** Narration over facts stage 2 already produced, using the existing
   `<documents>` grounding contract.

### Where thermal cost enters

```
MRT grid (GeoTIFF equivalent, per hour)
        |
        |  sample at edge midpoint
        v
OSWB v3 binary: each edge carries one mrt byte
        |
        |  graph.rs exposes it as the edge attribute "mrt"
        v
profile JSON multiplier: cost = length * f(mrt, mrt_comfort)
        |
        v
Dijkstra, unchanged
```

The consumer never knows how the grid was produced. Swapping a real SOLWEIG raster in is a
data change, not a code change. That is the whole point of putting the interface at the grid.

### OSWB v3

The v2 edge record is 18 bytes and has no spare field, so the format goes to v3 with one more
byte per edge. That is 2.2 MB added to a 34 MB file.

```
Edges (19 bytes, v3):
  u_idx   u32
  v_idx   u32
  length  f32    metres
  incline i16    actual * 10000
  footway u8
  surface u8
  flags   u8
  width   u8     actual * 5
  mrt     u8     NEW. mean radiant temperature in degrees C, offset by 20.
                 0 means unknown. 1..255 maps to 20.0 .. 147.5 C in 0.5 C steps.
                 Summer NYC street level MRT runs roughly 25 C to 70 C, so the
                 range has headroom and the quantisation error is 0.25 C.
```

`graph.rs::from_binary` accepts v2 and v3. On a v2 file every edge gets no `mrt` attribute,
which makes every thermal condition evaluate false, which makes thermal profiles degrade
exactly to their non thermal equivalents. That property is asserted by a router regression
test, and it is what alpha criterion 3 means by "identical where no thermal signal exists".

### Thermal cost function

`mrt_comfort` is a runtime arg with a default, so a clinician readable condition map can move
it per person without touching code. The penalty is continuous above the comfort threshold
rather than a step, because a step makes the router flip between two routes on a rounding
error.

Cost stays in metre equivalent units, which keeps the existing isochrone maths honest: the
thermal isochrone is a budget of *thermal metres*, and real walking time is still computed
from `length_m`. Both numbers get reported. Conflating them is how a demo ends up lying.

### Transit waits are priced thermally

This is the novel part and it lives in `router-service.ts`, in `tryMultimodal`. Today that
function scores a candidate as `walkIn + transitMinutes + walkOut + STATION_OVERHEAD_S`. The
station overhead is a flat 90 seconds regardless of where you stand.

A wait has a duration and a location, and that location has an MRT value. So the overhead
becomes `wait_seconds * thermal_load(stop_mrt)`. An unshaded elevated platform in July gets
expensive, and the router will sometimes prefer a longer walk over a short wait. Underground
stops invert this in summer, so a stop flagged underground gets a fixed moderate MRT instead
of the surface grid sample. Where the underground flag is unavailable the stop is treated as
surface level and that is recorded as unmodeled, not silently assumed.

---

## The thermal layer

**SOLWEIG is not running in this session and will not be.** UMEP is a QGIS plugin; a real run
wants LiDAR derived digital surface and canopy models, a sky view factor pass, and hours of
compute per neighborhood. Attempting it inside a 3 hour box would consume the box and produce
nothing else. The brief anticipates this and asks for a coarse proxy behind an identical
interface, which is what gets built, and the UI says which one is running.

The proxy is a physically motivated reduction of what SOLWEIG actually computes. SOLWEIG's
MRT at a point is driven by direct shortwave gain (is the point in sun or shadow), diffuse and
reflected shortwave from surrounding surfaces (governed by sky view factor), and longwave from
the sky and from hot vertical surfaces. The proxy keeps the two terms that dominate the street
level spread in a dense grid and drops the rest:

| Term | SOLWEIG | Proxy |
|---|---|---|
| Direct shortwave | Ray cast against a digital surface model | Solar geometry for the hour, cast against building footprint heights and street tree crowns |
| Sky view factor | Hemispherical from the DSM | Estimated from building height over street width in the cell |
| Canopy transmissivity | Per species leaf area | Fixed transmissivity, crown radius from trunk diameter |
| Longwave, reflected, wind, humidity | Modeled | Folded into a constant and the air temperature baseline |

Output is a 20 m grid over each target neighborhood, one layer per hour, stored as a compact
binary with a header carrying `ext:source`, `ext:source_timestamp`, `ext:pipeline_version`,
and a `tier` of `proxy`. When a SOLWEIG raster replaces it the tier becomes `modeled` and
nothing downstream changes.

The demo hour is 15:00 on a July afternoon, which is when NYC street level MRT peaks.

### Neighborhoods

Brownsville is the primary demo. Four more HVI 4 to 5 areas build from the same command so
the layer is not a single hand tuned case.

| NTA 2020 | Name | Borough |
|---|---|---|
| BK1602 | Brownsville | Brooklyn |
| BX0101 | Mott Haven, Port Morris | Bronx |
| BX0602 | Tremont | Bronx |
| MN1102 | East Harlem (North) | Manhattan |
| QN0303 | North Corona | Queens |

### Data sources

Every source is public and citable, and every dataset ID below was verified live against the
Socrata API during orientation, not recalled from memory.

| Dataset | ID | Used for | Licence |
|---|---|---|---|
| OpenSidewalks NYC v0.3.1-nyc.1 | GitHub release | Pedestrian graph, per edge provenance | ODbL 1.0 |
| Building Footprints (BUILDING) | `5zhs-2jue` | `height_roof`, `ground_elevation` for shadow casting and sky view factor | Public domain |
| 2015 Street Tree Census | `uvpi-gqnh` | Crown position and radius from `tree_dbh`, canopy shade | Public domain |
| Cool It! NYC 2020, Cooling Sites | `h2bn-gu9k` | The quarter mile comparison subject | Public domain |
| Cool It! NYC 2020, Drinking Fountains | `wxhr-qbhz` | Second class of outdoor cooling element | Public domain |
| Heat Vulnerability Index Rankings | `4mhf-duep` | HVI by ZCTA, neighborhood selection and the UI framing | Public domain |
| 2020 Neighborhood Tabulation Areas | `9nt8-h7nd` | Neighborhood boundaries, `nta2020` codes | Public domain |
| MTA GTFS, already compiled | in repo | Stop positions for thermal wait pricing | Public domain |

---

## No inferred medicine

`config/condition-map.yaml` ships versioned and human readable. It maps a fixed condition
vocabulary to routing implications, and the model classifies into that vocabulary and nothing
else. Every row carries a comment giving the rationale and, where one exists, a citation. A
clinician can read the file and challenge a row without reading any code.

The model is never asked what a condition implies. It is asked only which vocabulary term the
user's words match. The mapping from term to `mrt_comfort`, to a direct sun penalty, or to a
maximum continuous exposure, lives in the YAML.

## Profile is proposed, then confirmed

Stage 1 output renders as an editable card. Nothing routes until the user accepts or corrects
it. Every field the grammar can emit has a control on the card, so a dropped or invented
constraint is visible before it affects a route. Editing the card and re accepting re runs
stage 2 only, which is fast because no model is involved.

## Two new UI surfaces, and nothing else

The existing visual language stays. The shell is not redesigned.

The **profile confirmation card** sits where `ActiveRecord` sits, in the left column.

The **reachability comparison view** is the demo. Two shapes on the map: the city's quarter
mile circle, and the thermally accessible isochrone from the same origin. A delta readout
gives area in square kilometres, the count of Cool It! sites each shape claims, and an
estimated resident count. It has to read correctly to a non technical viewer in under five
seconds and survive a bad projector, so it gets checked at low contrast and against a
projector gamut before it is called done.

---

## Testing

| Layer | What it asserts |
|---|---|
| `npm run route -- thermal ...` | New CLI verb. Thermal versus shortest for an O and D pair, reporting both distances, both mean MRT values, and the delta in numbers. |
| Golden files, extraction | A fixture set of natural language queries to expected profile JSON. Includes contradictory constraints, a third party ("my grandma"), an empty query, and a language the model handles badly. Asserts 100 percent schema validity across all of them. |
| Router regression | Thermal routes differ from shortest where a thermal signal exists, and are byte identical where none does. |
| Playwright | The two new surfaces, added to the existing battery. |
| Multilingual gap | Measured and reported as a failure table. The highest HVI neighborhoods are where Bengali, Haitian Creole, and Spanish are household languages, and a 1B quantized model is weak outside English. The number goes in HANDOFF.md whatever it says. |

Fixtures do not get tuned to make numbers look better. The failure table is reported honestly.

---

## What I will NOT do

- **Run SOLWEIG, or process LiDAR.** Covered above. The proxy ships behind the real interface
  and the output says `tier: proxy` everywhere it appears.
- **Rebuild the OpenSidewalks graph.** It is already built, validated, and released. Rebuilding
  it would duplicate `opensidewalks-nyc` for no gain and would eat the timebox.
- **Rebuild the app side indexes from Overpass and Socrata.** The 60 to 90 minute
  `python -m pipeline build` path stays documented and still works. This session fetches the
  artifacts it already produced.
- **Swap the model.** Granite 4.0 1B stays. A model swap is a separate session with its own
  evaluation, and it threatens the box.
- **Add a routing profile per medical condition.** Conditions map onto a small set of
  numeric knobs in the condition map. A profile explosion is unmaintainable and unreviewable.
- **Re enable `navigator.geolocation`.** It stays feature gated off for the documented reason.
- **Introduce a network call on the query path.** The MTA SIRI boot call stays the only
  exception.
- **Redesign the shell,** add decorative motion, or add gradients that stand in for data.
- **Model humidity, wind, or personal metabolic rate.** Real MRT models want them. The proxy
  does not have them and will say so rather than invent them.
- **Citywide thermal coverage.** Five neighborhoods. Edges outside them carry `mrt = 0`, which
  means unknown, which makes thermal routing degrade to ordinary routing rather than guess.
- **Claim a population number I cannot source.** If block level 2020 counts do not land cheaply,
  the delta is reported in area and site count, and the resident estimate is labelled an areal
  interpolation or dropped.

---

## Timebox

3 hours. Status against the alpha criteria at 60 and 120 minutes, in under ten lines. If a
criterion is at risk the scope gets cut and the cut gets named.

Commit at each working checkpoint. A smaller thing that fully works beats a larger thing that
half works.

Order of work, most load bearing first, so that a cut at the end removes polish and not the
argument:

1. OSWB v3, `graph.rs` reader, thermal profile JSON, router regression test.
2. Thermal grid builder and the MRT attach step, for Brownsville first.
3. `npm run route -- thermal`, producing the criterion 3 numbers.
4. Thermal transit wait pricing, producing the criterion 4 mode flip.
5. XGrammar extraction, condition map, profile confirmation card.
6. The comparison view, producing the criterion 5 numbers.
7. Multilingual measurement, quality gate, teardown, HANDOFF.md.
