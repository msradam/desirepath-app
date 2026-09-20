# Ariadne HF Space Deployment Plan

## Architecture

```
User's browser
  └── downloads model once → IndexedDB cache → WebGPU inference (local, private)

HF Space (static SDK)
  └── serves app HTML/JS/CSS + routing graph + transit data

HF Model Repo (msradam/Granite-4.0-1b-q4f32_1-MLC)
  └── serves model shards via CDN (download source only. Model runs on client GPU)
```

The privacy guarantee: after the first visit, no network calls are made for inference.
Queries, routes, and user location never leave the browser.

## Why a separate model repo

- Space repo stays small (~50MB) → fast redeploys
- Model repo is append-only weights. Deploy independently
- HF CDN handles range requests and caching automatically
- Standard pattern used by MLC AI for all their official WebLLM Spaces

## Steps

### 1. Create HF model repo
- Repo: `msradam/Granite-4.0-1b-q4f32_1-MLC` (already exists; `scripts/setup-model.sh` clones it for local dev)
- Type: model
- Source files live in `<repo>/models/granite-1b/` after running the setup script. That directory mirrors the HF model repo
  - LFS tracked: `*.bin`, `*.wasm` (~893MB total)
  - Plain git: `*.json`, `*.txt` (small config/tokenizer files)
- Exclude: `*.so` (macOS Metal, not needed for WebGPU)

### 2. Update adapter for prod URL
In `src/lib/adapters/llm.ts`, use `import.meta.env.PROD` to switch:
- Dev:  `${origin}/granite-1b/`  (served by Vite plugin from local disk)
- Prod: `https://huggingface.co/msradam/Granite-4.0-1b-q4f32_1-MLC/resolve/main/`

### 3. Add COEP/COOP headers to Space README
HF Spaces natively supports these via `custom_headers` YAML. No service worker needed:
```yaml
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
```

### 4. Build and deploy Space
- `npm run build` (no env vars needed)
- rsync to `/tmp/ariadne-hf-deploy`
- Restore `.gitattributes`, transit binaries
- Commit + push

## Correct rsync command (copy-paste)

```bash
rsync -a --delete \
  --exclude '.git' \
  --exclude '.gitattributes' \
  --exclude 'README.md' \
  --exclude 'output/timetable.bin' \
  --exclude 'output/stops.bin' \
  --exclude 'output/ada-stops.json' \
  app/build/ \
  /tmp/ariadne-hf-deploy/
cd /tmp/ariadne-hf-deploy
git checkout HEAD -- .gitattributes output/timetable.bin output/stops.bin output/ada-stops.json
```

**Issue noted:** `--delete` removes `README.md` (which lives in the deploy repo but not in `build/`).
Fixed by adding `--exclude 'README.md'` to rsync. Without this, COEP/COOP headers disappear on every deploy.

## Known risks / watch points
- WASM MIME type: HF must serve `.wasm` as `application/wasm`. Verify in DevTools
- CORS on model repo: HF model repos are public and CORS-enabled by default
- IndexedDB cache key: if model URL changes, users re-download. Keep URL stable.
- `ndarray-cache.json` must be reachable at the model base URL. WebLLM reads it first
- `tensor-cache.json` / `tensor-cache-b16.json`: include both, WebLLM may need them

---

## DesirePath deployment (current)

**Space:** `https://huggingface.co/spaces/msradam/desirepath`
**Direct URL:** `https://msradam-desirepath.static.hf.space`
**Source:** `https://github.com/msradam/desirepath-app`
**Model repo:** unchanged, `msradam/Granite-4.0-1b-q4f32_1-MLC`

The Ariadne Space at `msradam/ariadne-nyc` is left alone and still serves the
version it always did.

### Which model runs where

`app/src/routes/+page.svelte` picks the adapter from `import.meta.env.PROD`:

| | default | why |
|---|---|---|
| Deployed Space | WebGPU (WebLLM) | a visitor has no Ollama on localhost, so defaulting to it would show "Ollama unreachable" and nothing else |
| Local | Ollama | the model is already resident in a process, which removes the 20 to 29 second cold start from every rebuild and every test |

`?llm=webgpu` and `?llm=ollama` override, so either can be demonstrated from
either place. **Check this first if a deployed Space cannot load a model.**

### What is excluded from the Space

`build/` is 232 MB, most of which is pipeline intermediates that nothing fetches
at runtime. The deploy excludes them and lands at 60 MB:

```bash
rsync -a \
  --exclude 'output/osw' \
  --exclude 'output/thermal' \
  --exclude 'output/nyc-pedestrian.bin' \
  app/build/ /tmp/desirepath-hf/
```

Runtime fetches only these under `/output/`: `nyc-pedestrian-thermal.bin`,
`nyc-comfort.json`, `nyc-pois.json`, `nyc-streets.json`, `ada-stops.json`,
`stops.bin`, `timetable.bin`, and `<NTA>-coverage.json`. Re-derive that list
with:

```bash
grep -rhno "/output/[A-Za-z0-9_./${}-]*" app/src --include='*.ts' --include='*.svelte' | sort -u
```

### Full deploy

```bash
cd app && npm run build
rsync -a --delete --exclude '.git' --exclude '.gitattributes' --exclude 'README.md' \
  --exclude 'output/osw' --exclude 'output/thermal' --exclude 'output/nyc-pedestrian.bin' \
  build/ /tmp/desirepath-hf/
cd /tmp/desirepath-hf && hf upload msradam/desirepath . --repo-type space \
  --commit-message "deploy"
```

`README.md` and `.gitattributes` live in the Space repo only, never in `build/`,
which is why both are excluded from `--delete`. Losing the README loses the
`custom_headers` block, and without those `crossOriginIsolated` is false and
WebLLM cannot allocate a SharedArrayBuffer.

**Use `hf upload`, not `git push`.** `hf auth login` stores its token where the
CLI can read it and git cannot, so a `git push` to the Space fails with
`could not read Username for 'https://huggingface.co'` even while the CLI is
authenticated. `hf upload` handles LFS for the three files that need it
(`nyc-pedestrian-thermal.bin`, `stops.bin`, `timetable.bin`).

`short_description` in the Space README is capped at 60 characters and the
upload is rejected outright if it is longer.

### Verified on deploy

```
crossOriginIsolated                          true
cross-origin-embedder-policy       require-corp
cross-origin-opener-policy          same-origin
/output/nyc-pedestrian-thermal.bin  206, application/octet-stream, ranges OK
/fonts/overpass-700.woff2           206, font/woff2
```

### Known gap

`/output/nyc-streets.json` 404s. It is the house-number address index and is
not built by the pipeline in this repo; `geocoder.loadStreets` is called with a
`.catch(() => {})` so the app degrades to named-place geocoding rather than
failing. Queries like "161 Amsterdam Avenue" will not resolve. This predates the
DesirePath work and is missing locally too.
