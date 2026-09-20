"""Rasterise the public inputs and assemble a thermal grid per neighbourhood.

This is the producer side of the interface. A SOLWEIG run would replace exactly
this file and leave `attach.py`, the OSWB v3 format, the cost rule tree and the
app untouched, because everything downstream consumes the raster and nothing
downstream knows how the raster was made.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import shapely
import shapely.ops
from pyproj import Transformer
from shapely.geometry import shape

from pipeline.thermal import grid as G
from pipeline.thermal import radiation as R
from pipeline.thermal import sources as S
from pipeline.thermal.solar import solar_position

NYC = ZoneInfo("America/New_York")
UTM18N = "EPSG:32618"
WGS84 = "EPSG:4326"

# Shadows fall into the neighbourhood from buildings outside it, so the raster
# is built on a margin and the margin is kept: an edge near the boundary needs
# a correct value too.
#
# The margin is generous for a second reason. An unsurveyed edge carries no
# thermal penalty, so a heat-aware route is rewarded for leaving coverage,
# which is a bias, not a finding. Covering a wide ring around each
# neighbourhood keeps realistic walking trips inside the surveyed area, and
# the CLI refuses to report a delta when two routes differ materially in how
# much of their length was surveyed. The underlying asymmetry is a known
# limitation; see HANDOFF.md.
MARGIN_M = 700.0

# ── reference meteorology ────────────────────────────────────────────────────
#
# The grid answers "where is it hot when it matters", so the design condition
# is a heat advisory, not an average afternoon.
#
# Air temperature: the National Weather Service New York office issues a Heat
# Advisory when the heat index is forecast to reach 95 to 99 F. Solving the NWS
# Rothfusz heat index for 95 F at the normal dew point below gives 34.3 C.
#
# Dew point and wind: NOAA NCEI 1991-2020 hourly climate normals for LaGuardia
# (USW00014732), 21 July at 15:00 local, the station nearest the demo
# neighbourhoods. Dew point normal 63.2 F, wind 12.1 mph.
#
# The wind is an open-airport 10 m measurement, which is what UTCI is defined
# against. A street canyon is more sheltered, and less wind means more heat
# stress, so using the airport value makes the derived thresholds conservative
# in the permissive direction. thresholds.py reports the sensitivity.
HEAT_ADVISORY_MET = R.Meteorology(
    air_temp_c=34.3,
    vapour_pressure_hpa=19.7,
    wind_10m_ms=5.41,
    label="NWS New York Heat Advisory threshold, NOAA 1991-2020 normals at LaGuardia",
    sources=(
        "NWS New York (OKX) Extreme Heat: Heat Advisory at heat index 95 to 99 F",
        "NOAA NCEI 1991-2020 hourly normals, USW00014732, 21 Jul 15:00 local",
    ),
)

_to_utm = Transformer.from_crs(WGS84, UTM18N, always_xy=True)
_to_wgs = Transformer.from_crs(UTM18N, WGS84, always_xy=True)


def _bbox_wgs(geom, margin_m: float) -> tuple[float, float, float, float]:
    """Geographic bbox of a geometry, grown by a margin given in metres."""
    min_lon, min_lat, max_lon, max_lat = geom.bounds
    x0, y0 = _to_utm.transform(min_lon, min_lat)
    x1, y1 = _to_utm.transform(max_lon, max_lat)
    a_lon, a_lat = _to_wgs.transform(x0 - margin_m, y0 - margin_m)
    b_lon, b_lat = _to_wgs.transform(x1 + margin_m, y1 + margin_m)
    return a_lon, a_lat, b_lon, b_lat


def _rasterise_buildings(
    rows: list[dict], origin_x: float, origin_y: float, shape_rc: tuple[int, int], cell_m: float
) -> tuple[np.ndarray, np.ndarray]:
    """Return (height raster in metres, inside-building mask).

    NYC records `height_roof` in feet above ground, so it converts directly to
    the obstruction height the sweep wants. Rows with no usable height are
    skipped rather than defaulted: a building of unknown height that we guess
    at would move a shadow somewhere it may not belong.
    """
    n_rows, n_cols = shape_rc
    height = np.zeros(shape_rc, dtype=np.float32)
    occupied = np.zeros(shape_rc, dtype=bool)
    skipped = 0

    for row in rows:
        raw = row.get("height_roof")
        try:
            h_m = float(raw) * G.FEET_TO_M
        except (TypeError, ValueError):
            skipped += 1
            continue
        if not (0.0 < h_m < 600.0):
            skipped += 1
            continue

        geom = shape(row["the_geom"])
        if geom.is_empty:
            continue
        # Project the footprint, then test the centre of every cell its bbox
        # covers. At 4 m this is a handful of cells per building.
        poly = shapely.ops.transform(_to_utm.transform, geom)
        bx0, by0, bx1, by1 = poly.bounds

        c0 = max(0, int((bx0 - origin_x) // cell_m))
        c1 = min(n_cols - 1, int((bx1 - origin_x) // cell_m))
        r0 = max(0, int((origin_y - by1) // cell_m))
        r1 = min(n_rows - 1, int((origin_y - by0) // cell_m))
        if c0 > c1 or r0 > r1:
            continue

        cc = origin_x + (np.arange(c0, c1 + 1) + 0.5) * cell_m
        rr = origin_y - (np.arange(r0, r1 + 1) + 0.5) * cell_m
        xs, ys = np.meshgrid(cc, rr)
        hit = shapely.contains_xy(poly, xs.ravel(), ys.ravel()).reshape(xs.shape)
        if not hit.any():
            # Small building that misses every cell centre. Claim its nearest
            # cell anyway, or a row of brownstones can vanish from the DSM.
            rc = (int((origin_y - poly.centroid.y) // cell_m), int((poly.centroid.x - origin_x) // cell_m))
            if 0 <= rc[0] < n_rows and 0 <= rc[1] < n_cols:
                height[rc] = max(height[rc], h_m)
                occupied[rc] = True
            continue

        block = height[r0 : r1 + 1, c0 : c1 + 1]
        np.maximum(block, np.where(hit, h_m, 0.0), out=block)
        occupied[r0 : r1 + 1, c0 : c1 + 1] |= hit

    return height, occupied


def _rasterise_canopy(
    rows: list[dict], origin_x: float, origin_y: float, shape_rc: tuple[int, int], cell_m: float
) -> tuple[np.ndarray, int]:
    """Canopy top height per cell, from street-tree points and their allometry."""
    n_rows, n_cols = shape_rc
    canopy = np.zeros(shape_rc, dtype=np.float32)
    used = 0

    for row in rows:
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
            dbh = float(row.get("tree_dbh") or 0.0)
        except (TypeError, ValueError, KeyError):
            continue
        if dbh <= 0:
            continue
        x, y = _to_utm.transform(lon, lat)
        radius = S.crown_radius_m(dbh)
        h = S.crown_height_m(dbh)

        span = int(np.ceil(radius / cell_m))
        c = int((x - origin_x) // cell_m)
        r = int((origin_y - y) // cell_m)
        r0, r1 = max(0, r - span), min(n_rows - 1, r + span)
        c0, c1 = max(0, c - span), min(n_cols - 1, c + span)
        if r0 > r1 or c0 > c1:
            continue

        cc = origin_x + (np.arange(c0, c1 + 1) + 0.5) * cell_m
        rr = origin_y - (np.arange(r0, r1 + 1) + 0.5) * cell_m
        xs, ys = np.meshgrid(cc, rr)
        within = (xs - x) ** 2 + (ys - y) ** 2 <= radius**2
        block = canopy[r0 : r1 + 1, c0 : c1 + 1]
        np.maximum(block, np.where(within, h, 0.0), out=block)
        used += 1

    return canopy, used


def build_neighbourhood(
    root: Path, nta2020: str, when: datetime, met: R.Meteorology | None = None
) -> tuple[G.ThermalGrid, dict]:
    """Fetch, rasterise, and compute the proxy MRT grid for one NTA."""
    met = met or HEAT_ADVISORY_MET
    nta_row, nta_src = S.fetch_nta(root, nta2020)
    geom = shape(nta_row["the_geom"])
    bbox = _bbox_wgs(geom, MARGIN_M)

    buildings, b_src = S.fetch_buildings(root, nta2020, bbox)
    trees, t_src = S.fetch_trees(root, nta2020, bbox)

    x0, y0 = _to_utm.transform(bbox[0], bbox[1])
    x1, y1 = _to_utm.transform(bbox[2], bbox[3])
    cell = G.CELL_M
    n_cols = int(np.ceil((x1 - x0) / cell))
    n_rows = int(np.ceil((y1 - y0) / cell))
    origin_x, origin_y = x0, y1  # north-west corner

    height, occupied = _rasterise_buildings(buildings, origin_x, origin_y, (n_rows, n_cols), cell)
    canopy, trees_used = _rasterise_canopy(trees, origin_x, origin_y, (n_rows, n_cols), cell)

    centroid = geom.centroid
    altitude, azimuth = solar_position(when, centroid.y, centroid.x)

    tg = G.build(
        nta2020, height, canopy, occupied, origin_x, origin_y,
        when, altitude, azimuth, met, cell,
    )

    walkable = ~occupied
    mrt_walkable = tg.mrt[walkable]
    finite = mrt_walkable[np.isfinite(mrt_walkable)]

    meta = {
        "nta2020": nta2020,
        "name": nta_row.get("ntaname"),
        "borough": nta_row.get("boroname"),
        "tier": "proxy",
        "method": "shadow and sky-view-factor proxy, see pipeline/thermal/grid.py",
        "not_solweig": True,
        "hour_local": when.isoformat(),
        "solar_altitude_deg": round(altitude, 2),
        "solar_azimuth_deg": round(azimuth, 2),
        "cell_m": cell,
        "rows": n_rows,
        "cols": n_cols,
        "buildings": len(buildings),
        "trees_used": trees_used,
        "meteorology": {
            "label": met.label,
            "air_temp_c": met.air_temp_c,
            "vapour_pressure_hpa": met.vapour_pressure_hpa,
            "wind_10m_ms": met.wind_10m_ms,
            "sources": list(met.sources),
        },
        "physics": {
            "governing_equation": "Tmrt = (Sstr / (eps_p * sigma))^0.25 - 273.15, Hoppe (1992) six-directional",
            "clear_sky": "Kasten and Czeplak (1980)",
            "diffuse_split": "Erbs, Klein and Duffie (1982)",
            "sky_emissivity": "Prata (1996)",
            "abs_shortwave": R.ABS_SHORTWAVE,
            "abs_longwave": R.ABS_LONGWAVE,
            "ground_albedo": R.GROUND_ALBEDO,
            "wall_albedo": R.WALL_ALBEDO,
            "surface_emissivity": R.SURFACE_EMISSIVITY,
            "sunlit_surface_excess_k": R.SUNLIT_SURFACE_EXCESS_K,
            "canopy_transmissivity": G.CANOPY_TRANSMISSIVITY,
        },
        "mrt_c": {
            "min": float(np.min(finite)) if finite.size else None,
            "median": float(np.median(finite)) if finite.size else None,
            "max": float(np.max(finite)) if finite.size else None,
            "shaded_share": float((finite < 45.0).mean()) if finite.size else None,
        },
        "sources": [nta_src.as_provenance(), b_src.as_provenance(), t_src.as_provenance()],
    }
    return tg, meta


def save(root: Path, tg: G.ThermalGrid, meta: dict) -> Path:
    """Write the grid as a compact .npz beside its JSON metadata."""
    out = root / "thermal" / f"{tg.nta2020}.npz"
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out,
        mrt_byte=G.encode_mrt(tg.mrt),
        svf=tg.svf.astype(np.float16),
        origin=np.array([tg.origin_x, tg.origin_y, tg.cell_m], dtype=np.float64),
    )
    (out.with_suffix(".json")).write_text(json.dumps(meta, indent=2) + "\n")
    return out


def load(root: Path, nta2020: str) -> tuple[G.ThermalGrid, dict]:
    """Read back a saved grid. Used by attach.py and the comparison view."""
    path = root / "thermal" / f"{nta2020}.npz"
    z = np.load(path)
    meta = json.loads(path.with_suffix(".json").read_text())
    ox, oy, cell = z["origin"]
    mrt = G.decode_mrt(z["mrt_byte"])
    return (
        G.ThermalGrid(
            nta2020=nta2020,
            hour_local=int(meta["hour_local"][11:13]),
            mrt=mrt,
            svf=z["svf"].astype(np.float32),
            sunlit=np.zeros_like(mrt),
            origin_x=float(ox),
            origin_y=float(oy),
            cell_m=float(cell),
            solar_altitude_deg=meta["solar_altitude_deg"],
            solar_azimuth_deg=meta["solar_azimuth_deg"],
        ),
        meta,
    )


def project(lons: np.ndarray, lats: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """WGS84 to UTM 18N, vectorised. Shared with attach.py."""
    return _to_utm.transform(lons, lats)
