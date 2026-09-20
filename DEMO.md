# DEMO

Five minutes. The click path below is the whole thing. Do not improvise a query on stage:
the model gets `intent` wrong about two thirds of the time and never once predicted
`plan_route` across 17 fixtures, so a fresh sentence is a coin flip. Every string here has
been run.

Static screenshots of every screen are in `docs/demo/`. If the live demo dies, the deck
can still carry the argument.

---

## Before you start

```bash
# Terminal 1. Serve the built app with the headers WebLLM needs.
cd app
VITE_MODEL_BASE=/granite-1b/ npm run build
rsync -a --exclude '.git' ../models/granite-1b/ build/granite-1b/
node scripts/serve-build.mjs 5190

# Terminal 2. Keep this open. It is the fallback if the browser misbehaves.
cd app
```

Open `http://localhost:5190/` in Chrome. **Wait for the search bar to become enabled
before you start talking.** Cold model load is the long pole: see timings below.

Have `http://localhost:5190/coverage?nta=BK1602` open in a second tab, already loaded.

---

## Timings, measured

Three cold runs, fresh browser profile each time, measured end to end.

| Step | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Coverage view, Brownsville | 0.4 s | 0.2 s | 0.2 s |
| Switching to North Corona | 0.0 s | 0.1 s | 0.0 s |
| **Model boot, cold profile** | **22.6 s** | **28.9 s** | **26.0 s** |
| Query to confirmation card | 2.4 s | 2.4 s | 2.4 s |
| Accept to route drawn | 0.1 s | 0.1 s | 0.1 s |

Worst case to plan around: **29 seconds of model boot**, then everything is fast. Open
the app tab and let it boot while you deliver the coverage argument, which needs no model
at all. By the time you switch tabs it is ready.

All three runs produced the same gap (9.4), the same route
(`25min · 1.2 mi · RUNTIME ● local`), and the same wrong intent
("What can I reach"), so the script below is reliable rather than lucky.

---

## The path

### 1. The argument, before the software (45 s)

Second tab, already open: `http://localhost:5190/coverage?nta=BK1602`

Say the claim out loud, it is on screen: *"no New Yorker in the most heat-burdened
communities is more than 1/4 mile away from an outdoor cooling element."* NYC DEP,
24 June 2020.

Point at the map. The red is pavement the quarter mile counts as covered that a
heat-burdened resident cannot actually walk to. The dashed circles are the claim. The
green is what they actually get.

**The number: 9.4 points.** Brownsville has two spray cooling elements for 2.86 km².

Then click **North Corona** in the neighbourhood bar.

> Zero. There is nothing there to be a quarter mile away from.

That is the strongest thirty seconds in the demo. Do not rush it.

Optional if you have time: click **East Harlem N** for the largest gap, 43.1 points,
79.0% claimed against 35.9% reachable in heat.

### 2. The router (90 s)

First tab. Type exactly:

```
Rockaway Avenue to Betsy Head Park
```

The confirmation card appears. **The model will probably get `intent` wrong.** It usually
says "What can I reach" rather than "Route between two places". This is the good part:

> The model filled in a form. It got this field wrong. Nothing has routed yet, and it
> cannot route until I agree with the form.

Click **Route between two places**. Fill the origin if it is blank, the model emits an
`@me` sentinel when the person did not say where they are and the card refuses to accept
until you answer it.

Read the consequence panel out loud: *Heat: not priced. Sun and shade cost the same per
metre.*

Click **Accept**. Route draws. 25 min, 1.2 mi, `RUNTIME ● Local`.

### 3. The condition changes the route (60 s)

Same query again:

```
Rockaway Avenue to Betsy Head Park
```

On the card, tick **Reduced ability to sweat** under conditions.

The consequence panel changes live, before anything routes:

> Heat: **priced**. Sun inflation 0.84: a metre in full sun is costed as 1.84 metres.
> Continuous exposure: capped at 7 minutes in one unbroken stretch of sun.

Say where that number comes from: it is beta minus one from Melnikov et al. 2022, who
estimated it from 408 observed pedestrian path choices. The file that decides it is
`config/condition-map.yaml`, readable by a clinician, no code.

Click **Accept**.

**Be honest about what happens next.** The route changes from 1858 m to 1877 m, mean
radiant temperature along it drops from 51.3 °C to 48.5 °C and the peak from 67.0 °C to
63.5 °C. The strip rounds both to "25 min · 1.2 mi", so the visible change is small.
Say the numbers rather than pointing at the screen. If you want them on screen instead,
Terminal 2:

```bash
npm run route -- thermal "Rockaway Avenue" "Betsy Head Park" generic_pedestrian 0.84
```

### 4. Offline (45 s)

This is the strongest single visual for the privacy argument.

In the address bar of a **third** tab, or via Terminal 2:

```bash
curl http://localhost:5190/__offline
```

It answers `offline. N assets were served before the cut.` The server now refuses every
request. Nothing is unloaded; the network simply dies, exactly as it would on a phone
leaving coverage.

Back in the first tab, run the query again and accept the card. The route draws.
`routed via osm_walk_graph · no network`.

Say the accurate version of the claim, not a bigger one:

> The model, the routing, the graph and the geocoder are all on the device. Nothing about
> the query or the destination leaves the browser.

Restore with `curl http://localhost:5190/__online` before anything else.

---

## If something breaks

**The model has not loaded.** The search bar stays disabled. Do not wait on stage. Go to
the coverage tab, which needs no model, and run the whole argument from there. The
coverage view is the deliverable; the router is the demonstration.

**Extraction refuses.** Measured at 3.92 percent before the single retry that now ships,
and 0 of 102 after it. If you somehow see one, retype the same query: it is transient,
and every refusal observed was rescued by one retry.

**The card shows something absurd.** Good. That is the demonstration. Correct it on the
card and accept. The point of the card is that a model this small is wrong often and a
person has to be in the loop before anything routes.

**The route does not draw.** Check the intent radio. If it is on "What can I reach" the
router looks for comfort resources instead of routing between two points, and you will
get "0 places" rather than a line.

---

## Numbers to have in your head

| | |
|---|---|
| Brownsville | 2 cooling elements, 12.8% claimed, 3.3% reachable in heat, **9.4 point gap** |
| East Harlem N | 18 elements, 79.0% claimed, 35.9% in heat, **43.1 point gap** |
| North Corona | **0 elements** |
| Best thermal routing case | East Harlem, **−14.5 °C mean MRT for +22 m**, +1.6% |
| Extraction | **3 of 17** fixtures exactly right |
| Intent | wrong in **65%** of runs; majority-class baseline would be 53% wrong |
| Decoder refusals | **3.92%** before retry, **0 of 102** after |
| Heat deaths, NYC | about **500 a year** (DOHMH, 2018-2022) |
| PM2.5 deaths, NYC | about **2,000 a year** (DOHMH). Not "more than 2,000", and not one in twenty |

## Do not say

- "No PII." Routing, destinations and the graph stay local; that is the accurate claim.
  If a future version sends the sentence to a server for extraction, the sentence is
  exactly where the health condition and the address are.
- "SOLWEIG." The radiant field is a proxy and every artifact labels it `tier: proxy`.
- "Curbside air quality." The NYCCAS rasters are 300 m. That is corridor scale, and both
  sides of a street fall in one cell.
