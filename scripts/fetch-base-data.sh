#!/usr/bin/env bash
# Fetch the prebuilt base artifacts ariadne-thermal extends.
#
# Two upstreams, both public:
#
#   1. opensidewalks-nyc release v0.3.1-nyc.1 — the canonical OpenSidewalks
#      v0.3 pedestrian graph of NYC. Validator-clean (python-osw-validation
#      0.4.4, 0 errors, 3,374,261 features). We pull per-borough splits, not
#      the 2 GB citywide GeoJSON, because the thermal layer is built per
#      neighborhood. This is the OSW source of record; we do not rebuild it.
#
#   2. The deployed ariadne-nyc HuggingFace Space — the app-side indexes and
#      the compiled OSWB v2 binary. These are outputs of the ariadne-nyc
#      pipeline (`python -m pipeline build`, 60-90 min against Overpass and
#      Socrata). Fetching them is the fast path; the slow path is documented
#      in ariadne-nyc's README and still works.
#
# Everything here is regenerable. data/ is gitignored.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"
OSW="$DATA/osw"
mkdir -p "$DATA" "$OSW"

SPACE="https://msradam-ariadne-nyc.static.hf.space"
OSW_RELEASE="https://github.com/msradam/opensidewalks-nyc/releases/download/v0.3.1-nyc.1"

# Boroughs holding the heat-burdened neighborhoods the thermal layer covers.
# Override with: BOROUGHS="BK BX" ./scripts/fetch-base-data.sh
BOROUGHS="${BOROUGHS:-BK BX MN QN}"

fetch() {  # fetch <url> <dest>
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then
    echo "  have  $(basename "$dest")"
    return
  fi
  echo "  get   $(basename "$dest")"
  curl -fSL --retry 3 --progress-bar -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

echo "ariadne-nyc app indexes + OSWB v2 binary ($SPACE)"
for f in nyc-pedestrian.bin nyc-pois.json nyc-comfort.json timetable.bin stops.bin ada-stops.json; do
  fetch "$SPACE/output/$f" "$DATA/$f"
done

echo
echo "OpenSidewalks v0.3 borough splits (opensidewalks-nyc v0.3.1-nyc.1)"
for b in $BOROUGHS; do
  fetch "$OSW_RELEASE/nyc-osw-$b.geojson.gz" "$OSW/nyc-osw-$b.geojson.gz"
done

echo
echo "data/:"
ls -lh "$DATA" | tail -n +2 | awk '{printf "  %-24s %s\n", $9, $5}'
echo "data/osw/:"
ls -lh "$OSW" | tail -n +2 | awk '{printf "  %-24s %s\n", $9, $5}'
