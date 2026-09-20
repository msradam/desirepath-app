"""Fetch the public inputs the thermal grid needs, and cache them on disk.

Three NYC Open Data sources, all public domain, all verified live against the
Socrata API rather than recalled:

  9nt8-h7nd  2020 Neighborhood Tabulation Areas   the neighbourhood boundary
  5zhs-2jue  BUILDING                             height_roof, for shadow and SVF
  uvpi-gqnh  2015 Street Tree Census, Tree Data   crown position and size

Responses are cached under data/thermal/raw/ keyed by dataset and NTA, so a
rebuild of the grid does not re-hit the API. Set SOCRATA_APP_TOKEN to raise the
rate limit from 1 request per second to 1000; the pipeline works without one.

This is a build-time fetch. Nothing here runs on the query path.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

SOCRATA = "https://data.cityofnewyork.us/resource"
PAGE = 50_000

NTA_DATASET = "9nt8-h7nd"
BUILDING_DATASET = "5zhs-2jue"
TREE_DATASET = "uvpi-gqnh"

# Street-tree allometry. Both are rules of thumb for open-grown urban street
# trees, not fitted allometries, and both are deliberately exposed as constants
# so they can be calibrated against a canopy raster later. The NYC census
# records tree_dbh in inches.
CROWN_SPREAD_FT_PER_DBH_IN = 1.25   # crown spread in feet per inch of trunk diameter
CROWN_RADIUS_BOUNDS_M = (1.0, 9.0)
TREE_HEIGHT_BASE_M = 2.5
TREE_HEIGHT_PER_DBH_IN_M = 0.35
TREE_HEIGHT_BOUNDS_M = (4.0, 25.0)

FEET_PER_METRE = 3.280839895


@dataclass(frozen=True)
class SourceRecord:
    """One fetched dataset, with the provenance the OSW pipeline expects."""

    dataset_id: str
    name: str
    rows: int
    retrieved_at: str
    url: str

    def as_provenance(self) -> dict[str, Any]:
        return {
            "ext:source": f"NYC Open Data {self.dataset_id} ({self.name})",
            "ext:source_timestamp": self.retrieved_at,
            "dataset_id": self.dataset_id,
            "rows": self.rows,
            "url": self.url,
            "license": "Public Domain (NYC Open Data)",
        }


def bbox_key(nta2020: str, bbox: tuple[float, float, float, float]) -> str:
    """Cache key that changes when the requested extent changes.

    Keying on the NTA code alone is wrong: widening the margin would silently
    reuse a narrower fetch, leaving the outer ring with no buildings and no
    trees, which makes it look uniformly sunlit. Four decimal places is about
    11 m, well under the 4 m grid's own margin of error.
    """
    return nta2020 + "-" + "_".join(f"{v:.4f}" for v in bbox)


def _cache_path(root: Path, dataset: str, key: str) -> Path:
    p = root / "thermal" / "raw" / f"{dataset}-{key}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _get(dataset: str, params: dict[str, str]) -> list[dict]:
    """One paginated Socrata query. Raises on a non-200 rather than returning
    a partial result, because a silently short building list makes every cell
    downwind of the gap look sunlit."""
    token = os.environ.get("SOCRATA_APP_TOKEN")
    headers = {"X-App-Token": token} if token else {}
    out: list[dict] = []
    offset = 0
    while True:
        page = dict(params, **{"$limit": str(PAGE), "$offset": str(offset)})
        r = requests.get(f"{SOCRATA}/{dataset}.json", params=page, headers=headers, timeout=120)
        r.raise_for_status()
        rows = r.json()
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        offset += PAGE


def _cached(root: Path, dataset: str, key: str, params: dict[str, str]) -> list[dict]:
    path = _cache_path(root, dataset, key)
    if path.exists():
        return json.loads(path.read_text())
    rows = _get(dataset, params)
    path.write_text(json.dumps(rows))
    return rows


def fetch_nta(root: Path, nta2020: str) -> tuple[dict, SourceRecord]:
    """Return the NTA's GeoJSON geometry and its provenance record."""
    rows = _cached(
        root, NTA_DATASET, nta2020,
        {"$where": f"nta2020='{nta2020}'", "$select": "nta2020,ntaname,boroname,the_geom"},
    )
    if not rows:
        raise SystemExit(f"no NTA matches nta2020={nta2020!r}")
    row = rows[0]
    rec = SourceRecord(
        NTA_DATASET, "2020 Neighborhood Tabulation Areas", len(rows),
        _now(), f"{SOCRATA}/{NTA_DATASET}.json",
    )
    return row, rec


def fetch_buildings(root: Path, nta2020: str, bbox: tuple[float, float, float, float]) -> tuple[list[dict], SourceRecord]:
    """Building footprints with roof height, for the bbox.

    bbox is (min_lon, min_lat, max_lon, max_lat). Socrata's within_box takes
    (north, west, south, east), which is not the same order, so the swap
    happens here once rather than at every call site.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    rows = _cached(
        root, BUILDING_DATASET, bbox_key(nta2020, bbox),
        {
            "$where": f"within_box(the_geom, {max_lat}, {min_lon}, {min_lat}, {max_lon})",
            "$select": "the_geom,height_roof,ground_elevation",
        },
    )
    rec = SourceRecord(
        BUILDING_DATASET, "BUILDING (NYC building footprints)", len(rows),
        _now(), f"{SOCRATA}/{BUILDING_DATASET}.json",
    )
    return rows, rec


def fetch_trees(root: Path, nta2020: str, bbox: tuple[float, float, float, float]) -> tuple[list[dict], SourceRecord]:
    """Living street trees in the bbox, with trunk diameter."""
    min_lon, min_lat, max_lon, max_lat = bbox
    rows = _cached(
        root, TREE_DATASET, bbox_key(nta2020, bbox),
        {
            "$where": (
                f"latitude between {min_lat} and {max_lat} "
                f"AND longitude between {min_lon} and {max_lon} "
                "AND status='Alive'"
            ),
            "$select": "latitude,longitude,tree_dbh,spc_common,health",
        },
    )
    rec = SourceRecord(
        TREE_DATASET, "2015 Street Tree Census, Tree Data", len(rows),
        _now(), f"{SOCRATA}/{TREE_DATASET}.json",
    )
    return rows, rec


def crown_radius_m(dbh_inches: float) -> float:
    """Crown radius from trunk diameter, by the open-grown street-tree rule of
    thumb that crown spread in feet runs a little over trunk diameter in inches."""
    spread_ft = CROWN_SPREAD_FT_PER_DBH_IN * dbh_inches
    radius = (spread_ft / FEET_PER_METRE) / 2.0
    lo, hi = CROWN_RADIUS_BOUNDS_M
    return min(hi, max(lo, radius))


def crown_height_m(dbh_inches: float) -> float:
    """Height to the top of the crown. Only its relation to the sun altitude
    matters, so the linear form is adequate at a 4 m cell size."""
    h = TREE_HEIGHT_BASE_M + TREE_HEIGHT_PER_DBH_IN_M * dbh_inches
    lo, hi = TREE_HEIGHT_BOUNDS_M
    return min(hi, max(lo, h))


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def demo() -> None:
    """Self-check the allometry bounds and the bbox argument order.

    Network calls are not exercised here; the fetch functions are covered by
    actually running the pipeline, which is what the build command does.
    """
    assert crown_radius_m(0) == CROWN_RADIUS_BOUNDS_M[0]
    assert crown_radius_m(1000) == CROWN_RADIUS_BOUNDS_M[1]
    # A 12-inch street tree should land in the two-to-three metre range.
    r12 = crown_radius_m(12)
    assert 1.8 < r12 < 2.6, r12
    # Monotone, or a bigger tree would cast a smaller shadow.
    assert crown_radius_m(6) < crown_radius_m(18) < crown_radius_m(30)
    assert crown_height_m(6) < crown_height_m(18) < crown_height_m(30)
    assert crown_height_m(0) == TREE_HEIGHT_BOUNDS_M[0]

    # The cache key must move when the extent moves, or a wider rebuild
    # silently reuses a narrower fetch.
    b1 = (-74.0, 40.6, -73.9, 40.7)
    b2 = (-74.1, 40.6, -73.9, 40.7)
    assert bbox_key("BK1602", b1) != bbox_key("BK1602", b2)
    assert bbox_key("BK1602", b1) == bbox_key("BK1602", b1)
    assert bbox_key("BK1602", b1) != bbox_key("BX0101", b1)

    # within_box order is (north, west, south, east). Guard the swap.
    import re
    src = Path(__file__).read_text()
    clause = re.search(r"within_box\(the_geom, ([^)]*)\)", src).group(1)
    assert clause == "{max_lat}, {min_lon}, {min_lat}, {max_lon}", clause

    print("sources.py self-check passed")


if __name__ == "__main__":
    demo()
