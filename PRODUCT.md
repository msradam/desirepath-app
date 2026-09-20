# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, one engine.

**Residents of heat-burdened New York neighbourhoods.** Someone in Brownsville, Mott
Haven, Tremont, East Harlem or North Corona who needs to get somewhere on foot in the
heat, and for whom the shortest route and the survivable route are not the same. Many
have a condition that changes what a walk costs them: they cannot sweat normally, they
use a wheelchair, they are 82, they are pregnant. They are on a phone, outdoors, and the
answer has to arrive before they give up on it.

**Organisers, researchers and civic technologists.** Someone holding the city to a public
promise, or evaluating whether the method behind the number is sound. They need the
provenance, the dataset IDs and the honest limits as much as the figure.

The room the software is shown in contains both, and the coverage view is what it is
shown for.

## Product Purpose

New York's Cool It! plan claims that "no New Yorker in the most heat-burdened communities
is more than 1/4 mile away from an outdoor cooling element" (NYC DEP, 24 June 2020). That
quarter mile is measured as a straight line. DesirePath measures the same claim along the
sidewalk network a person actually has to walk, with heat priced into the cost of every
metre, and shows the difference.

Success is that a viewer who has never seen the software understands, inside five
seconds, that the red pavement is counted as covered and cannot be reached.

## Positioning

The contribution is the OpenSidewalks graph, not this app. Sidewalks, crossings, kerb
ramps and their attributes are first-class edges rather than tags hanging off a road
centreline, which is what makes "can this person actually walk there" a question the data
can answer at all. DesirePath is a consumer of that graph.

The claim that follows is the one a neighbouring product cannot copy: climate-aware
routing is a natural extension of accessibility routing, and the evidence is that nothing
in the data model had to change to add it. Heat became one more cost term on one more
edge attribute, beside kerb height and crossing width.

## Operating Context

Shown on a projector in a bright room, from a laptop, to people sitting at the back. Also
opened on a phone by someone standing outside in the heat. Both are real and the second
is the one the product is for.

Everything on the query path runs on the machine it is opened on. The model is Granite 4,
either in the browser on WebGPU or in Ollama on the same machine; the routing, the graph
and the geocoder are local. The accurate privacy claim is that the sentence and the
destination do not reach the internet, not that nothing leaves the browser.

## Capabilities and Constraints

- **Coverage view.** For a chosen neighbourhood, three readings of the same quarter-mile
  claim: as the crow flies, walking the network, and walking it in the heat. The gap
  between the first and the last is the figure. Five neighbourhoods have surveyed thermal
  data: Brownsville, Mott Haven, Tremont, East Harlem N, North Corona.
- **Routing view.** A typed sentence becomes a profile object, the profile is confirmed
  or corrected by the person on a card, and only then does anything route. Three stages:
  natural language to profile (model, grammar-constrained), profile to route (no model at
  all), route to explanation (model, over stage-2 facts only).
- **The card is not decoration.** Every field the schema can produce has a control on it,
  so a constraint the model dropped is visible before it can affect a route. Editing it
  changes the route.
- **What a condition implies is a file, not code.** `config/condition-map.yaml`, versioned,
  readable by a clinician, arguable with.
- **Thermal cost is mean radiant temperature**, modelled from a shadow and sky-view-factor
  sweep. It is a proxy, not SOLWEIG, and every artifact carries `tier: proxy`.
- Sun inflation runs 0.16 to 0.84, from Melnikov et al. (2022), estimated from 408 observed
  pedestrian path choices. A metre in full sun costs up to 1.84 metres.
- The model is small and often wrong. That is a finding the interface has to carry, not
  hide.
- Offline on the query path, with one boot-time exception (MTA SIRI). No
  `navigator.geolocation`.

## Brand Commitments

- The name is **DesirePath**, camel-case, one word.
- It must not look like Ariadne, the accessibility router it extends, and it must not look
  like a research tool with a map dropped into it.
- Voice: plain declarative sentences. Say the number and say what it does not cover. Never
  claim more than was measured. "Do not say" list in DEMO.md is binding.

## Evidence on Hand

- OpenSidewalks NYC graph, OSW v0.3, Taskar Center for Accessible Technology.
- NYC DEP Cool It! quarter-mile claim, 24 June 2020, quoted verbatim in the interface.
- NYC cooling elements: spray showers and misting stations, by NTA.
- NYC Heat Vulnerability Index, neighbourhoods scoring 4 and 5.
- Measured coverage figures: Brownsville 12.8% claimed against 3.3% reachable in heat, a
  9.4 point gap, 2 cooling elements for 2.86 km². East Harlem N, 43.1 point gap. North
  Corona, zero elements.
- Extraction measured against the real model, reported honestly including the failures:
  see HANDOFF.md section 3.
- No user research, no interviews, no deployment. Nothing in the interface may imply
  otherwise.

## Product Principles

1. **The graph is the contribution.** Say so near the top, in the README and in the
   product. The app demonstrates what the data makes possible.
2. **Nothing routes until a person agrees with the form.** A dropped constraint must be
   impossible, not unlikely.
3. **State the limit next to the number.** A proxy is labelled a proxy on the screen it
   appears on, not in a footnote nobody opens.
4. **The shortfall is the artifact.** Not the route, not the model. What the quarter mile
   counts as covered and a person cannot walk to.
5. **Measured, cited, or cut.** Every coefficient traces to a published source or to a
   file that says it is a judgement.

## Accessibility & Inclusion

The product is about who a route excludes, so the interface cannot exclude on the same
axes. Nothing carried by colour alone, on any screen. Large type and high contrast, for a
bright projector and for low vision. Full keyboard operation on the card, since it is the
control surface that decides what a route costs someone. No horizontal scroll at 390 CSS
pixels.
