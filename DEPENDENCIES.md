# Dependencies added by the thermal layer

The policy for this project is that every new dependency is a liability until
proven otherwise: reuse before addition, verify existence on the registry before
adding, pin exactly, and record what was tried first.

One dependency was added. Everything else the thermal layer needs was already
in `pyproject.toml` or already shipping inside an existing package.

---

## thermofeel 2.3.0

**License** Apache-2.0, matching this repository's own license.
**Maintainer** ECMWF, the European Centre for Medium-Range Weather Forecasts.
**Registry** https://pypi.org/project/thermofeel/ , verified live.
**Source** https://github.com/ecmwf/thermofeel , verified live: 98 stars, last
pushed 2026-08-06, not archived, Apache-2.0 confirmed on the repository itself.
**Released** 2.3.0 on 2026-07-16, comfortably inside the six-month activity bar.
**Transitive tree** One runtime dependency, `numpy`, which this project already
depends on. Everything else in its metadata is a test or examples extra.

**What it does here.** It implements the Universal Thermal Climate Index
operational polynomial from Bröde et al. (2012), a sixth-order fit in 210
coefficients over air temperature, mean radiant temperature, wind speed and
vapour pressure. `pipeline/thermal/thresholds.py` uses it to invert the official
UTCI thermal stress category boundaries back into mean radiant temperature at
the reference meteorology, so the router's severity labels come from the
published scale rather than from numbers this project chose.

**What was tried first.**

Nothing at all, first. The original thermal cost used four hand-chosen mean
radiant temperature thresholds and four hand-chosen cost multipliers. They were
invented, and they were wrong: they implied a worst-case cost of 3.92 times
plain distance, where the published behavioural estimates put it near 1.16.
Replacing them required a defensible thermal stress scale, and the only one with
an operational standard behind it is UTCI.

Implementing the polynomial by hand was considered and rejected. It is 210
coefficients transcribed by eye, with no way to tell a transcription error from
a real result, and it would have had to be transcribed twice to keep Python and
TypeScript in step.

SOLWEIG's own implementation was considered and rejected on licensing. The UMEP
SOLWEIG package is GPL-3.0 and this repository is Apache-2.0, so its UTCI and
Tmrt code cannot be copied in. The published *equations* it implements are used,
cited to Lindberg et al. (2008) and Höppe (1992), but no code was taken.

`pythermalcomfort` was considered and rejected on its transitive tree. It is MIT
licensed and well maintained, and it clamps inputs to the polynomial's validity
range where thermofeel extrapolates, which is a genuine advantage. But it pulls
in `scipy` and `numba`, neither of which this project otherwise needs, and
`numba` in particular is a heavy compiled addition for one function. The
validity range is enforced here instead, explicitly, in
`pipeline/thermal/thresholds.py::mrt_at_utci`, which bounds its search to the
documented window of 30 K below to 70 K above air temperature and returns a
marker rather than a number when a category falls outside it.

**Where it runs.** Build time only. It is used to derive constants that are
written into `router/examples/profile-*.json` and
`app/src/lib/domain/thermal-constants.ts`. Nothing imports it at query time, and
the offline guarantee is untouched.

---

## Considered and not added

**pvlib** for the Erbs et al. (1982) diffuse fraction correlation. The
correlation is four lines of published arithmetic and is implemented directly in
`pipeline/thermal/radiation.py`, cited to the 1982 paper. pvlib's source was read
to confirm the coefficients and breakpoints, but the package was not added.

**A solar position library** for the NOAA position algorithm. Implemented in
`pipeline/thermal/solar.py`, about forty lines, self-checked against
astronomical invariants rather than against a recalled table.

**A raster library** (rasterio, xarray) for the thermal grid. The grid is a
numpy array with an origin and a cell size; it is written with
`numpy.savez_compressed`. rasterio is already an indirect dependency of the base
pipeline, but nothing here needs georeferenced raster I/O.

**XGrammar or any grammar library** for constrained decoding. Not needed:
`@mlc-ai/web-llm@0.2.82`, already a dependency, bundles
`@mlc-ai/web-xgrammar@0.1.27` and exposes it through
`response_format: { type: 'grammar', grammar: ... }`. Verified by unpacking the
published tarball and reading `lib/openai_api_protocols/chat_completion.d.ts`.

---

## Data sources

All public, all with a recorded dataset identifier, all verified live against
their API during the build rather than recalled.

| Dataset | Identifier | Used for | License |
|---|---|---|---|
| OpenSidewalks NYC | GitHub release `v0.3.1-nyc.1` | Pedestrian graph | ODbL-1.0 |
| BUILDING (NYC building footprints) | `5zhs-2jue` | `height_roof` for shadow and sky view factor | Public domain |
| 2015 Street Tree Census | `uvpi-gqnh` | Crown position and size | Public domain |
| 2020 Neighborhood Tabulation Areas | `9nt8-h7nd` | Neighbourhood boundaries | Public domain |
| Cool It! NYC 2020 Cooling Sites | `h2bn-gu9k` | The quarter-mile comparison | Public domain |
| Cool It! NYC 2020 Drinking Fountains | `wxhr-qbhz` | Second class of cooling element | Public domain |
| Heat Vulnerability Index Rankings | `4mhf-duep` | Neighbourhood selection | Public domain |
| MTA Subway Stations | `39hk-dx4f` (data.ny.gov) | Platform structure, for thermal wait pricing | Public domain |
| NOAA NCEI 1991-2020 Climate Normals | station `USW00014732` | Reference meteorology | Public domain |
