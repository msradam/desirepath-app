"""Thermal profile of every subway platform, for pricing transit waits.

A RAPTOR transfer has a duration and a location, and that location has a
radiant environment. Waiting eight minutes on an unshaded elevated platform in
July is not the same as waiting eight minutes underground, and the router
should not price them the same.

Platform class comes from MTA Subway Stations (data.ny.gov `39hk-dx4f`), whose
`structure` column distinguishes Elevated, Viaduct, Subway, Open Cut,
Embankment and At Grade. It joins to the compiled GTFS by `gtfs_stop_id`.

Where the platform is at or above street level the MRT is sampled from the
same neighbourhood grid the edges use. Where it is underground there is no sky
and no direct beam, so the grid does not apply and a constant stands in. That
constant is an assumption and is labelled as one; see UNDERGROUND_PLATFORM_MRT_C.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import requests

from pipeline.thermal import build as B

STATIONS_DATASET = "39hk-dx4f"
STATIONS_URL = f"https://data.ny.gov/resource/{STATIONS_DATASET}.json"

# Platform classes that sit in the open air at or above street level. An
# elevated platform is the worst case in the system: no canopy reaches it, the
# surrounding buildings rarely rise above it, and the structure itself is dark
# steel.
OPEN_AIR = {"Elevated", "Viaduct", "At Grade", "Open Cut", "Embankment"}
UNDERGROUND = {"Subway"}

# An elevated platform sits above the street, so the neighbourhood grid, which
# is computed at ground level, understates it: buildings and trees that shade
# the pavement do not reach the platform. This raises an open-air elevated
# sample toward the fully exposed value rather than inventing a new number.
ELEVATED_EXPOSURE_FLOOR = 0.85   # fraction of the grid's own maximum

# ASSUMPTION, NOT A MEASUREMENT.
#
# An underground platform has no sky view and no direct beam, so its mean
# radiant temperature is close to the temperature of the surfaces around it,
# which is the platform air temperature. NYC underground platforms trap train
# waste heat and are widely reported to sit above street air temperature in
# summer. This build has no measured platform temperatures, so a single
# constant stands in for all of them.
#
# The consequence is deliberate and is the inversion the design calls for: at a
# July afternoon peak an exposed elevated platform is far worse than
# underground, while in a well-shaded street the underground platform is
# slightly worse. Replace this with measurements when they exist; nothing else
# has to change.
UNDERGROUND_PLATFORM_MRT_C = 37.0
UNDERGROUND_TIER = "assumed"


def fetch_stations(root: Path) -> list[dict]:
    """Station list with platform structure, cached on disk."""
    cache = root / "thermal" / "raw" / f"{STATIONS_DATASET}.json"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if cache.exists():
        return json.loads(cache.read_text())
    r = requests.get(
        STATIONS_URL,
        params={"$select": "gtfs_stop_id,stop_name,structure,gtfs_latitude,gtfs_longitude,borough", "$limit": "5000"},
        timeout=120,
    )
    r.raise_for_status()
    rows = r.json()
    cache.write_text(json.dumps(rows))
    return rows


def build_stop_thermal(root: Path, ntas: list[str]) -> dict:
    """Return {gtfs_stop_id: {...}} plus a provenance block."""
    stations = fetch_stations(root)

    lat = np.array([float(s["gtfs_latitude"]) for s in stations])
    lon = np.array([float(s["gtfs_longitude"]) for s in stations])
    x, y = B.project(lon, lat)

    sampled = np.full(lat.shape, np.nan, dtype=np.float32)
    grid_max = 0.0
    for nta in ntas:
        tg, _meta = B.load(root, nta)
        finite = tg.mrt[np.isfinite(tg.mrt)]
        if finite.size:
            grid_max = max(grid_max, float(finite.max()))
        vals = tg.sample(x, y)
        take = np.isnan(sampled) & np.isfinite(vals)
        sampled[take] = vals[take]

    out: dict[str, dict] = {}
    counts = {"open_air": 0, "underground": 0, "unsurveyed": 0, "unknown_structure": 0}

    for i, s in enumerate(stations):
        structure = (s.get("structure") or "").strip()
        stop_id = s.get("gtfs_stop_id")
        if not stop_id:
            continue

        if structure in UNDERGROUND:
            entry = {
                "mrt_c": UNDERGROUND_PLATFORM_MRT_C,
                "structure": structure,
                "underground": True,
                "tier": UNDERGROUND_TIER,
            }
            counts["underground"] += 1
        elif structure in OPEN_AIR:
            v = float(sampled[i]) if np.isfinite(sampled[i]) else None
            if v is None:
                entry = {"mrt_c": None, "structure": structure, "underground": False, "tier": "unsurveyed"}
                counts["unsurveyed"] += 1
            else:
                if structure in ("Elevated", "Viaduct") and grid_max > 0:
                    v = max(v, ELEVATED_EXPOSURE_FLOOR * grid_max)
                entry = {"mrt_c": round(v, 1), "structure": structure, "underground": False, "tier": "proxy"}
                counts["open_air"] += 1
        else:
            entry = {"mrt_c": None, "structure": structure or "unknown", "underground": None, "tier": "unmodelled"}
            counts["unknown_structure"] += 1

        entry["name"] = s.get("stop_name")
        out[stop_id] = entry

    return {
        "stops": out,
        "counts": counts,
        "neighbourhoods": ntas,
        "underground_assumption": {
            "mrt_c": UNDERGROUND_PLATFORM_MRT_C,
            "tier": UNDERGROUND_TIER,
            "note": (
                "Assumed, not measured. No sky view and no direct beam, so MRT tracks "
                "platform air temperature, which NYC underground platforms raise above "
                "street level in summer. Replace with measurements when available."
            ),
        },
        "elevated_exposure_floor": ELEVATED_EXPOSURE_FLOOR,
        "sources": [
            {
                "ext:source": f"MTA Subway Stations (data.ny.gov {STATIONS_DATASET})",
                "dataset_id": STATIONS_DATASET,
                "url": STATIONS_URL,
                "rows": len(stations),
                "license": "Public Domain (MTA)",
                "used_for": "platform structure class",
            }
        ],
    }


def demo() -> None:
    """Self-check the classification rules without touching the network."""
    assert "Elevated" in OPEN_AIR and "Viaduct" in OPEN_AIR
    assert "Subway" in UNDERGROUND
    assert not (OPEN_AIR & UNDERGROUND), "a platform cannot be both"

    # The inversion the design depends on: at a July peak, underground beats an
    # exposed elevated platform; in deep shade it does not.
    exposed_peak = 62.0
    deep_shade = 35.0
    assert UNDERGROUND_PLATFORM_MRT_C < exposed_peak, "underground must win at peak sun"
    assert UNDERGROUND_PLATFORM_MRT_C > deep_shade, "and lose in a well-shaded street"

    print("stops.py self-check passed")


if __name__ == "__main__":
    demo()
