# DEMO

Five minutes. The click path below is the whole thing. Every string here has been run.

Static screenshots of both screens are in `docs/demo/`. If the live demo dies, the deck can
still carry the argument.

---

## Before you start

Easiest: open the deployed Space, which runs the model itself.
`https://msradam-desirepath.hf.space` for the router,
`https://msradam-desirepath.hf.space/coverage?nta=BK1602` for the notice.

To run it locally instead:

```bash
# Terminal 1. The model. Nothing downloads: granite4:micro is already pulled.
ollama serve

# Terminal 2. Serve the built app with the headers it needs.
cd app
npm run build
node scripts/serve-build.mjs 5190

# Terminal 3. Keep this open. It is the fallback if the browser misbehaves.
cd app
```

Open `http://localhost:5190/coverage?nta=BK1602` and `http://localhost:5190/` in Chrome.
Both are ready in seconds: the model is resident in Ollama, so there is no cold model load
to wait out on stage. The WebGPU build is still there at `?llm=webgpu` if you want the
in-browser story, and that one does pay a 20 to 29 second first load.

**Know which engine you are on before you talk about privacy.** The disclosure block above
the route says so in one line: in your browser, on this machine, or on the server. Only the
first keeps the sentence in the page.

---

## The path

### 1. The argument, before the software (60 s)

The coverage tab, already open.

Read the claim out loud. It is on screen, quoted, with its date: *"no New Yorker in the
most heat-burdened communities is more than 1/4 mile away from an outdoor cooling element."*
NYC DEP, 24 June 2020.

Then point at the two numbers next to each other. The claim counts **12.8%** of
Brownsville's sidewalk network. Walking it in the heat reaches **3.3%**.

**The figure: 9.4 points.** Two cooling elements for 2.86 km².

On the map, the orange is pavement the quarter mile counts as covered that a heat-burdened
resident cannot actually walk to. The dashed circles are the claim. The blue is what they
get.

Then click **North Corona**.

> Zero. There is nothing there to be a quarter mile away from.

That is the strongest thirty seconds in the demo. Do not rush it.

Optional: **East Harlem N** has the largest gap, 43.1 points, 79.0% claimed against 35.9%
reachable in heat.

### 2. The router (90 s)

First tab. Type exactly:

```
Rockaway Avenue to Betsy Head Park
```

The route draws, and above it a block says what the model read out of the sentence: the
request it dispatched to, the conditions it picked up, and whether heat was priced.

Point at **Request**. It reads **Route between two places**. That is worth stopping on:

> This used to be a field the model predicted. It got it wrong in 65 percent of runs. The
> cause was the schema, not the model: the decoder emits keys in the order the schema
> declares them, and the intent field came first, before the destination and the time
> budget that are the only evidence for it. The model had to classify the sentence before
> it had read it into the form. So the field is gone, and three lines of code derive the
> tool from the slots instead. The control is still here, because a derived answer can be
> wrong about an ambiguous sentence.

Read the **Heat** line: *not priced*. No condition was stated, so sun and shade cost the
same per metre. 25 min, 1.2 mi, `RUNTIME ● Local`.

### 3. The condition changes the route (60 s)

Now type a sentence that states one:

```
Rockaway Avenue to Betsy Head Park, I can't handle the heat
```

The **Heat** line changes to *priced, sun inflation 0.63*, and the conditions line names
what it read.

Where that number comes from: it is beta minus one from Melnikov et al. (2022), estimated
from 408 observed pedestrian path choices. The file that decides it is
`config/condition-map.yaml`, readable by a clinician, no code.

**Be honest about what happens next.** The route changes from 1858 m to 1877 m, mean
radiant temperature along it drops from 51.3 °C to 48.5 °C and the peak from 67.0 °C to
63.5 °C. The strip rounds both to "25 min · 1.2 mi", so the visible change is small. Say
the numbers rather than pointing at the screen. If you want them on screen, Terminal 3:

```bash
npm run route -- thermal "Rockaway Avenue" "Betsy Head Park" generic_pedestrian 0.84
```

### 4. Offline (45 s)

In Terminal 3:

```bash
curl http://localhost:5190/__offline
```

It answers `offline. N assets were served before the cut.` The server now refuses every
request. Nothing is unloaded; the network simply dies, as it would on a phone leaving
coverage.

Back in the first tab, run the query again and accept the card. The route draws.
`routed via osm_walk_graph · no network`.

Say the accurate version of the claim, not a bigger one:

> The routing, the graph and the geocoder are all in this browser, and they keep working
> with the network cut. Where the sentence goes depends on which engine is running, and the
> app says which: in the browser it goes nowhere, on this machine it goes to localhost, on
> the Space it goes to the Space.

Restore with `curl http://localhost:5190/__online` before anything else.

---

## If something breaks

**The search bar stays disabled.** Ollama is not running, or `granite4:micro` is not
pulled. Check Terminal 1. Do not wait on stage: go to the coverage tab, which needs no
model at all, and run the whole argument from there. The coverage view is the deliverable;
the router is the demonstration.

**Extraction refuses.** Measured at 3.92 percent before the single retry that now ships,
and 0 of 102 after it. Retype the same query: every refusal observed was rescued by one
retry.

**The disclosure block shows something absurd.** Say so out loud, because it is the
demonstration: a model this small is wrong often, and the block is there so the person can
see what it decided rather than discovering it in the route. There is no longer a way to
correct it before routing; that trade is recorded in HANDOFF.md section 2c.

**The request says "Route between two places" for a "find me a" query.** Stage 1 writes the
kind of place into the destination field. If the destination will not route, dispatch
retries it as a search for the nearest one and says so in yellow above the route. That
notice is the interesting part, not a glitch to apologise for.

---

## Numbers to have in your head

| | |
|---|---|
| Brownsville | 2 cooling elements, 12.8% claimed, 3.3% reachable in heat, **9.4 point gap** |
| East Harlem N | 18 elements, 79.0% claimed, 35.9% in heat, **43.1 point gap** |
| North Corona | **0 elements** |
| Best thermal routing case | East Harlem, **−14.5 °C mean MRT for +22 m**, +1.6% |
| Intent, before it was deleted | wrong in **65%** of runs; majority-class baseline would be 53% wrong |
| Dispatch, after | derived from two slots, reproduces **17 of 17** fixtures with no inference |
| Confirmation card | **removed.** What the model read is disclosed after routing, not before |
| Decoder refusals | **3.92%** before retry, **0 of 102** after |
| Heat deaths, NYC | about **500 a year** (DOHMH, 2018-2022) |
| PM2.5 deaths, NYC | about **2,000 a year** (DOHMH). Not "more than 2,000", and not one in twenty |

## Do not say

- "No PII." Routing, destinations and the graph stay in the browser; that is the accurate
  claim. Where the sentence goes depends on the engine, and the disclosure block names it.
  Read it before claiming anything about privacy.
- "SOLWEIG." The radiant field is a proxy and every artifact labels it `tier: proxy`.
- "Curbside air quality." The NYCCAS rasters are 300 m. That is corridor scale, and both
  sides of a street fall in one cell.
- "The model picks the tool." It does not any more. Two slots do.
- "Nothing can be silently dropped." That was true when the confirmation card existed. It
  no longer is: a condition the model misses now reaches the route, and the person finds
  out from the disclosure block afterwards.
