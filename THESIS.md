# DesirePath

## The claim

On 24 June 2020 New York City published Cool It! NYC and stated that no New Yorker in the
most heat-burdened communities is more than a quarter mile from an outdoor cooling element.

The quarter mile is a straight line. Nobody walks a straight line. Between a resident and a
spray shower there are blocks, crossings, a kerb that may or may not have a ramp, and on a
July afternoon a stretch of pavement with nothing over it. A claim measured as a radius and
a walk measured in metres of sun are different quantities, and the gap between them is not
a rounding error. In Brownsville the quarter mile counts 12.8 percent of the sidewalk
network as covered. Walking the real network reaches 7.9 percent. Walking it with heat
priced into each metre reaches 3.3 percent. The claim overstates what the neighbourhood
gets by 9.4 points, from two cooling elements serving 2.86 km².

In East Harlem N the same calculation gives a 43.1 point gap. In North Corona it gives
nothing at all, because North Corona has no spray showers and no misting stations. There is
nothing there to be a quarter mile away from.

## The graph is the contribution

None of this is a routing result. It is a data result.

The measurement above is possible because the sidewalk is a first-class object in the
OpenSidewalks schema rather than an attribute of the road beside it. A crossing is an edge.
A kerb ramp is a node with a height. A sidewalk has a width, a surface and an incline, and
it connects to other sidewalks at places a person can actually cross. Ask a road centreline
network whether somebody in a wheelchair can get from here to there and it cannot answer,
because it never represented the thing they travel on. Ask the OpenSidewalks graph and it
answers, because it did.

DesirePath is a consumer of that graph. The interesting claim belongs to the data, and the
application exists to show what the data makes answerable.

## Climate is an accessibility constraint, and the data model already knew

The strongest evidence for treating heat as an accessibility problem is negative: adding it
required no change to the data model.

Mean radiant temperature entered as one more attribute on an edge, beside width and
incline. Sensitivity to it entered as one more cost term, beside the terms for kerb height
and crossing length. The cost function is a weighted sum over edge attributes either way,
and the router did not learn a new concept. It learned a new column.

That is not a convenience. It is the argument. A person who cannot tolerate a long
unshaded block and a person who cannot mount an unramped kerb are both people for whom the
shortest path is not the available path, and a network that can express one can express the
other without being redesigned. Accessibility routing built the machinery; climate routing
is a second tenant in it.

The same reasoning predicts the next tenants. Air quality along a corridor, night-time
lighting, flooding, surface condition after snow: each is an edge attribute plus a
coefficient, and each becomes routable the moment somebody surveys it.

## Where the numbers come from

The scale that converts sun into distance is measured, not chosen. Melnikov et al. (2022)
estimated pedestrian path choice in heat from 408 observed path choices and found that
walking in the sun is treated as roughly 16 percent longer than walking the same distance
in shade, with individual estimates reaching 84 percent. Those two figures are the ends of
the scale this project uses: `sun_inflation` runs 0.16 to 0.84, so a metre in full sun
costs the router between 1.16 and 1.84 metres. Basu et al. (2024) estimated the same
behaviour independently from GPS trips in Boston and arrived at a coefficient that converts
to about 0.63 in these units, which falls inside that range.

Where a given condition sits on the scale is a design judgement, not a measurement, and
`config/condition-map.yaml` says so in as many words. The file is versioned, readable
without reading any code, and is the only place a routing consequence is written. A
clinician who disagrees with where impaired sweating sits can argue with a YAML file rather
than with a model.

The thermal field itself is modelled, not sensed. It follows the six-directional
formulation that SOLWEIG uses, with sky view factor and shadow computed on a 4 m grid.
Lindberg and Grimmond (2011) developed and evaluated that shadow and mean radiant
temperature scheme, and Lindberg, Onomura and Grimmond (2016) extended it to ground surface
characteristics. Every artifact this pipeline writes carries `tier: proxy`, because a proxy
that is labelled is evidence and a proxy that is not is a claim.

## Shade alone is not the measurement

It would be cheaper to route on shade. Shade is a binary that a shadow mask gives you for
free, and several published systems do exactly that: Li et al. (2019) minimise sunlight
exposure at pedestrian level, and Wen et al. (2025) route dynamically on shade to improve
comfort in arid cities.

The reason this project prices radiant temperature instead is that shade and thermal relief
are not the same quantity. Middel's shade measurements in Phoenix found relief spanning
roughly 22.8 to 30.9 K depending on what was casting the shadow and what the ground was
made of, which means two shaded segments can differ from each other by more than a shaded
segment differs from an unshaded one. A route optimised on a shade bitmask cannot tell
those apart. One optimised on modelled radiant temperature can, and this pipeline's own
shade relief of 28.8 K sits inside that measured range, which is the check that the model
is in the right physical territory.

Cabrera, Ziegler and Schläpfer (2025) make the complementary argument on the supply side,
targeting cooling interventions along a cycling network instead of treating a city as a
uniform surface. Coverage measured along the network applies the same idea to the claim,
where they apply it to the remedy.

## What this does not model

Wind is absent. The cost is radiation-only, so a windy canyon and a still one are priced
alike. The radiant field is a proxy rather than SOLWEIG proper. Hydrant spray caps, which
the City opens during heat advisories, are not in the published dataset and are not
counted, so the coverage figures describe published infrastructure rather than everything
that exists on a hot afternoon. Thermal survey covers five neighbourhoods, about 7.66
percent of the city's edges; everything outside them routes exactly as it did before.

The language model is small and gets things wrong often enough that the confirmation card
is not a courtesy. It is the mechanism that makes a dropped constraint visible before it
can reach a route.

## Sources

Every work below was read. Where this document makes a claim with no source attached, that
is deliberate: no citation was available that had actually been opened, and an unverified
citation would be worse than none.

| Work | Used for |
|---|---|
| Melnikov, V.R., Krzhizhanovskaya, V.V., Lees, M.H. and Sloot, P.M.A. (2022). Behavioural thermal regulation explains pedestrian path choices in hot urban environments. *Scientific Reports* 12, 2441. doi:10.1038/s41598-022-06383-5 | The sun inflation scale, 0.16 to 0.84 |
| Basu, R., Colaninno, N., Alhassan, A. and Sevtsuk, A. (2024). Hot and bothered: exploring the effect of heat on pedestrian route choice behavior and accessibility. *Cities* 155, 105435. doi:10.1016/j.cities.2024.105435 | Independent revealed-preference check on that scale |
| Lindberg, F. and Grimmond, C.S.B. (2011). The influence of vegetation and building morphology on shadow patterns and mean radiant temperatures in urban areas. *Theoretical and Applied Climatology* 105, 311–323. doi:10.1007/s00704-010-0382-8 | The shadow and radiant temperature scheme |
| Lindberg, F., Onomura, S. and Grimmond, C.S.B. (2016). Influence of ground surface characteristics on the mean radiant temperature in urban areas. *International Journal of Biometeorology* 60(9), 1439–1452 | Ground surface contribution to that scheme |
| Middel, A. 50 Grades of Shade. *Bulletin of the American Meteorological Society* | Measured shade relief, 22.8 to 30.9 K |
| Li, X., Yoshimura, Y., Tu, W. and Ratti, C. A pedestrian level strategy to minimize outdoor sunlight exposure in hot summer. *Building and Environment* | Prior art on shade-minimising pedestrian routing |
| Wen, J., Abuhani, D.A., Mazzarello, M., Duarte, F., Norford, L., Xu, R., Wong, N.H. and Ratti, C. (2025). Walking smart in the heat: a dynamic shade-oriented pathfinding approach to enhance pedestrian comfort in arid cities. *Computers, Environment and Urban Systems* 122, 102337 | Prior art on dynamic shade-oriented pathfinding |
| Cabrera, A., Ziegler, D. and Schläpfer, M. (2025). Targeted cooling of urban cycling networks for heat-resilient mobility. arXiv:2512.11753 | Network-targeted cooling on the supply side |

The OpenSidewalks schema and the NYC graph built from it are cited as the artifacts they
are, in `DEPENDENCIES.md` and in the provenance stamped on every pipeline output, rather
than through a paper. The claim under test is quoted from NYC DEP, Mayor de Blasio Expands
Cool It! NYC, 24 June 2020, and appears verbatim on the coverage screen with its date.

The idea that a feature built for a constrained group ends up serving everyone is well
known in accessibility work and is the reason the third section above is worth stating.
No citation is given for it here because none was verified while writing this.
