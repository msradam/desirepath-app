# HANDOFF

`ariadne-thermal` extends [`ariadne-nyc`](https://github.com/msradam/ariadne-nyc) with a thermal
cost layer, so the pedestrian router optimises heat exposure alongside distance and accessibility.

The headline is one comparison. New York's Cool It! programme promises that
"no New Yorker in the most heat-burdened communities is more than 1/4 mile away
from an outdoor cooling element" (NYC DEP, 24 June 2020). "Away from" is a
straight line. Measured against what a heat-burdened pedestrian can actually
walk to on the OpenSidewalks graph, the claim covers between 9 and 43 points
more of a neighbourhood's sidewalk network than the network delivers, and one
of the five neighbourhoods has no outdoor cooling element at all.

---

## What is built

| Piece | Where | What it is |
|---|---|---|
| Thermal grid | `pipeline/thermal/` | Proxy mean radiant temperature at 4 m, per neighbourhood, from three public datasets |
| OSWB v3 | `pipeline/thermal/attach.py`, `router/src/graph.rs` | One byte per edge carrying MRT. v2 still loads. |
| Thermal cost | `router/src/cost.rs`, `router/examples/profile-*.json` | A continuous distance-inflating term, off by default |
| Transit wait pricing | `app/src/lib/services/router-service.ts` | A wait is priced by where it is spent |
| Condition map | `config/condition-map.yaml` | Condition vocabulary to routing parameters, versioned, no code |
| Grammar extraction | `pipeline/thermal/grammar.py`, `app/src/lib/services/extraction.ts` | Stage 1, masked at the logit level |
| Comparison view | `app/src/lib/components/ThermalCoverage.svelte` | The demo, at `/coverage?nta=BK1602` |
| Confirmation card | `app/src/lib/components/ProfileCard.svelte` | Nothing routes until the user accepts |

Five Heat Vulnerability Index 4 to 5 neighbourhoods build from one command:
Brownsville (BK1602), Mott Haven and Port Morris (BX0101), Tremont (BX0602),
East Harlem North (MN1102), North Corona (QN0303).

---

## Reproducing it

```bash
git clone <this repo> && cd ariadne-thermal

# 1. Base artifacts and the app's static links. Minutes, not hours.
./scripts/fetch-base-data.sh

# 2. Python side
uv venv && uv pip install -e .

# 3. The thermal layer. About 90 seconds for all five neighbourhoods.
uv run python -m pipeline.thermal build

# 4. Derived cost parameters, the routing profiles, and the extraction grammar
uv run python -m pipeline.thermal.profiles
uv run python -m pipeline.thermal.grammar

# 5. Router
cd router && cargo build && wasm-pack build --target web --out-dir pkg && cd ..

# 6. App
cd app && npm ci

# 7. The numbers
npm run route -- thermal-suite
npm run route -- coverage BK1602
npm run route -- transit "Atlantic Avenue" "Broadway Junction"

# 8. The model, only needed for the two model-touching stages
cd .. && ./scripts/setup-model.sh
```

The base pedestrian graph comes from the deployed ariadne-nyc HuggingFace
Space rather than a 60 to 90 minute Overpass rebuild. The OpenSidewalks v0.3
borough splits come from the `opensidewalks-nyc` release `v0.3.1-nyc.1`, which
is already validator clean. Neither is rebuilt here, on purpose.

---

## The numbers

### Criterion 3: thermal routes differ from shortest routes, measurably

`npm run route -- thermal-suite`, nine cases, no failures.

| Case | Shortest | Detour | Mean MRT | Change |
|---|---|---|---|---|
| East Harlem North | 1405 m | +22 m (+1.6%) | 59.2 to 44.6 C | **-14.5 C** |
| Mott Haven | 1964 m | +2 m (+0.1%) | 56.1 to 50.1 C | -5.9 C |
| Brownsville, cross-neighbourhood | 1627 m | +8 m (+0.5%) | 54.8 to 50.2 C | -4.6 C |
| Brownsville, station to park | 1858 m | +20 m (+1.1%) | 51.3 to 48.5 C | -2.8 C |
| Penn Station to Grand Central | 1716 m | **+0 m** | no MRT data | 0.0 C |
| Union Square to Washington Square | 1004 m | **+0 m** | no MRT data | 0.0 C |

The last two rows matter as much as the first. Where no thermal signal exists
the heat-aware route is byte-identical to the shortest one, because an
unsurveyed edge carries no `mrt` attribute rather than a default of zero.

For comparison with published systems: Cool Routes reports up to -3.8 C for
detours under 3 percent; Kolaxidis et al. (2025) 16 to 29 percent less solar
exposure for about 3 percent; Wen et al. (2025) 8.8 percent less sun for 1.3
percent. These numbers sit in that range rather than above it.

### Criterion 5: the quarter-mile comparison

Strict reading, spray showers and misting stations only, which is what the
Cool It! announcement means by "outdoor cooling element". Shares are of the
walkable sidewalk network inside the neighbourhood boundary.

| Neighbourhood | Elements | As the crow flies | Walking | Walking in the heat | Gap |
|---|---|---|---|---|---|
| East Harlem North | 18 | 79.0% | 60.5% | 35.9% | **43.1 points** |
| Mott Haven, Port Morris | 9 | 56.8% | 42.9% | 21.4% | **35.4 points** |
| Tremont | 8 | 56.1% | 49.0% | 31.6% | **24.4 points** |
| Brownsville | 2 | 12.8% | 7.9% | 3.3% | **9.4 points** |
| North Corona | **0** | none | none | none | the claim covers nothing |

In area: East Harlem North's quarter mile claims 1.92 km2 and delivers 0.87
km2 to a heat-burdened resident. Brownsville's claims 0.37 km2 and delivers
0.10 km2.

Including drinking fountains, which the same programme counts but which are
hydration rather than cooling, Brownsville goes to 86.4 percent claimed and
56.4 percent reachable in heat, a 30.0 point gap. Both readings are computed;
the view leads with the strict one.

### Criterion 4: the thermal transfer penalty and the mode decision

Implemented, tested, and **it does not change a mode decision at the demo
hour**. This is a negative result and it is reported rather than tuned away.

A wait is priced as `wait_seconds * thermal_load(platform_mrt)`. Platform class
comes from MTA Subway Stations (`39hk-dx4f`): 283 underground, 27 open-air
sampled from the grid, 186 open-air outside coverage. An exposed elevated
platform in Brownsville samples 62 to 63 C; underground is an assumed 37 C.

The reason nothing flips is structural, and worth knowing before anyone tries
to fix it: at 15:00 on a weekday the lines serving these neighbourhoods run
every two to four minutes, so the wait being priced is 1 to 4 minutes. At the
population-mean coefficient that is about 20 thermal seconds of penalty, and
at the most sensitive coefficient in the condition map about 100. The walk
legs, being kilometres rather than minutes, dominate by an order of magnitude.
Swept across the whole observed coefficient range, 0.16 to 0.84, on every pair
tried, no mode and no boarding station changed.

An earlier build did show a mode flip, driven into the underground system by
heat. That result came from a cost function whose worst case was 3.92x plain
distance, which the literature does not support. When the coefficient was
corrected to the measured 1.16, the flip disappeared. The honest conclusion is
that thermally priced waits matter where headways are long, and NYC peak
headways are short.

### The multilingual gap

FILLED IN FROM THE RUN. See "Known issues" if this section is still a
placeholder.

---

## What is faked or proxied, and where

**The mean radiant temperature field is a proxy, not SOLWEIG.** This is the
single largest caveat and it is labelled `tier: proxy` in every artifact, every
CLI line and the comparison view itself.

What is the same as SOLWEIG: the governing equation. Tmrt is derived from the
six-directional radiant flux of Höppe (1992) with the published angular factors
for a standing body (0.06 up and down, 0.22 per side, 0.28 cylinder) and the
published absorption coefficients (0.70 shortwave, 0.97 longwave), inverted
through Stefan-Boltzmann. Clear-sky irradiance is Kasten and Czeplak (1980),
the direct and diffuse split is Erbs et al. (1982), sky emissivity is Prata
(1996).

What is different: the geometry. SOLWEIG resolves a LiDAR digital surface model
at 1 m. This resolves extruded building footprints at 4 m, with tree crowns
from the street tree census rather than a canopy model. It also fixes the sky
at clear, the hour at one, and drops wind, humidity, and the anisotropic sky.

How it was checked: building shade buys 28.8 K of Tmrt here. Middel et al.
(2021) measured 22.8 to 30.9 K from urban form across 1,988 samples; Du et al.
(2020) report 28.8 K in Harbin. Sunlit 61 to 66 C and shaded 33 to 38 C sit
inside what Li et al. (2023) map for Philadelphia, the closest published
humid-continental analogue.

**The underground platform temperature is assumed, not measured.** A single
constant of 37 C stands in for every underground platform, labelled
`tier: assumed`. No measured NYC platform temperatures were available. It is
one constant in `pipeline/thermal/stops.py` and replacing it changes nothing
else.

**Where a condition sits on the cost scale is a design judgement.** The scale
is empirical: Melnikov et al. (2022) estimate a population mean of 1.16 and
individual values to 1.84 from 408 observed path choices. Placing "cannot
sweat" at the top of that observed range is this project's call, not a
measurement, and `config/condition-map.yaml` says so in as many words.

**The resident counts are absent, not estimated.** No 2020 population by 2020
NTA was available cheaply, so the comparison reports network share and area and
does not claim a number of people. Area itself is derived from node share
assuming even node density, which is labelled where it appears.

**The elevated-platform exposure floor** raises an elevated platform's sampled
MRT toward the grid maximum, because the grid is computed at ground level and a
platform sits above the shade that reaches the pavement. That is a correction,
not a measurement.

---

## Known issues

**An unsurveyed edge is free.** The thermal term charges nothing where there is
no `mrt` attribute, which is correct (unknown is not cool) but creates a bias:
a heat-aware route is never penalised for leaving the surveyed area. The zero
point is anchored at full shade rather than at thermal comfort, which means an
unsurveyed edge costs exactly what a fully shaded one costs rather than less
than every surveyed edge, and that removes most of the bias. The margin around
each neighbourhood is wide enough that ordinary trips stay inside it, and the
CLI refuses to report a delta when two routes differ by more than five points
of surveyed share. It is mitigated, not solved.

**Coverage is 7.66 percent of the city's edges.** Five neighbourhoods out of
roughly 200. Everything outside them routes exactly as it did before.

**One hour, one sky.** The grid is built for 15:00 on 21 July under a clear
sky at a heat advisory air temperature. Morning and evening, when shadows are
long and many people are actually travelling, are not built.

**The Cool It! dataset is the permanent mapped set.** The City also opens
hydrant spray caps during heat advisories, and those are not in the published
data and are not counted. The comparison view says so on its face. This is the
strongest objection to the headline number and it is stated rather than buried.

**Humidity, wind and air quality are unmodelled.** `config/condition-map.yaml`
lists them explicitly under `unmodelled` rather than leaving their absence to
be read as "not a risk".

**A regular street grid limits what shade routing can do.** Wolf et al. (2024)
show that on a perfect grid with uniform building heights the benefit is
mathematically independent of the sun-aversion coefficient, and Manhattan
gains only from grid irregularity and heterogeneous building heights. The
Manhattan numbers here should be read with that in mind.

---

## The three highest-value next steps

**1. Run SOLWEIG for one neighbourhood and diff it against the proxy.**
Everything is already shaped for this. `pipeline/thermal/grid.py` and
`radiation.py` are the only files a real run replaces; `attach.py`, the OSWB v3
format, the cost tree and the app all consume the raster and do not know how it
was made. The deliverable is a scatter of proxy against modelled Tmrt on the
same 4 m cells, and an honest RMSE. SOLWEIG validation against MaRTy reports
about 5.6 C RMSE; this proxy should be worse, and by how much is the number
that decides whether the proxy is publishable on its own.

**2. Build the hourly layer and price time, not distance.**
One hour is the sharpest limitation. Building 08:00, 12:00, 15:00 and 18:00
would cost four times the compute, which is about six minutes, and would let
the router answer "when should I leave" as well as "which way should I go". It
also opens the one place where this project would have to extend the
literature rather than follow it: every calibrated coefficient found was
estimated against distance at an assumed constant walking speed, so a slow
walker's longer exposure on the same segment is currently unpriced. Wang et
al. (2022) is the only published thermal budget denominated in minutes and is
the place to start.

**3. Get a measured underground platform temperature, and a New York
route-choice coefficient.**
The two weakest numbers in the build are both assumptions standing in for
measurements that could exist. Platform temperature needs a sensor and a
summer. The route-choice coefficient currently comes from 46 students in
Singapore, cross-checked against GPS traces in Boston; the population this
router is aimed at is older, sicker and less acclimatised than either. A
stated-preference instrument run in Brownsville would replace the single
weakest link in the argument.

---

## Provenance

Every dataset identifier was verified live against its API during the build,
not recalled. Licences, the one added dependency, and the alternatives that
were rejected are in `DEPENDENCIES.md`. The derivation of every cost parameter
is printed by `uv run python -m pipeline.thermal.thresholds`.
