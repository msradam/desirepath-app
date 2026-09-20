"""Urban geometry for the thermal grid: shadow and sky view factor.

This module answers two geometric questions per cell, against a building height
raster: how much of the sky hemisphere is visible, and is the direct beam
reaching the ground. `radiation.py` turns those two numbers into a mean radiant
temperature through a published radiation budget.

The split matters. Geometry is where this differs from SOLWEIG, which resolves
the same quantities at 1 m against a LiDAR digital surface model rather than at
4 m against extruded building footprints. Physics is where it agrees: the Tmrt
equation, its angular factors and its absorption coefficients are the published
ones. The output is labelled tier=proxy everywhere it appears.

Sky view factor is computed by hemispherical integration over sixteen azimuths,
following the standard discrete-direction approach: for each azimuth the
horizon angle is the largest elevation any obstacle subtends, and the visible
sky fraction in that direction is the cosine squared of it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from pipeline.thermal import radiation as R

CELL_M = 4.0

#: Fraction of the direct beam transmitted through a tree crown in leaf.
#: SOLWEIG's default transmissivity for vegetation in full leaf is 3 percent;
#: NYC street trees are a mix of species and crown densities and many are
#: pruned hard under utility lines, so this is deliberately more permissive.
#: It is the one place a crown is treated as a filter rather than a wall.
CANOPY_TRANSMISSIVITY = 0.15

# How far to look when testing for obstruction. At the demo hour the sun sits
# at 58 degrees, so a 40 m building casts a 25 m shadow; 150 m covers the low
# sun angles too, and the sweep cost is linear in this.
MAX_OBSTRUCTION_M = 150.0
SVF_AZIMUTHS = 16

FEET_TO_M = 0.3048


@dataclass
class ThermalGrid:
    """A north-up raster of proxy MRT in degrees Celsius.

    `mrt[0, 0]` is the north-west corner. Cells are square in the projected
    frame, which is UTM zone 18N for all of NYC.
    """

    nta2020: str
    hour_local: int
    mrt: np.ndarray            # float32, degrees C
    svf: np.ndarray            # float32, 0 to 1, kept for the quality report
    sunlit: np.ndarray         # float32, 0 to 1
    origin_x: float            # easting of the west edge, metres
    origin_y: float            # northing of the north edge, metres
    cell_m: float
    solar_altitude_deg: float
    solar_azimuth_deg: float

    @property
    def shape(self) -> tuple[int, int]:
        return self.mrt.shape

    def sample(self, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        """Nearest-cell MRT at projected coordinates. NaN outside the raster.

        Nearest-cell rather than bilinear on purpose: the underlying signal is
        a hard shadow edge, and interpolating across it invents a warm strip
        where the real street has none.
        """
        rows, cols = self.mrt.shape
        c = np.floor((xs - self.origin_x) / self.cell_m).astype(np.int64)
        r = np.floor((self.origin_y - ys) / self.cell_m).astype(np.int64)
        inside = (r >= 0) & (r < rows) & (c >= 0) & (c < cols)
        out = np.full(xs.shape, np.nan, dtype=np.float32)
        out[inside] = self.mrt[r[inside], c[inside]]
        return out


def _shifted(arr: np.ndarray, dr: int, dc: int) -> np.ndarray:
    """`out[r, c] = arr[r + dr, c + dc]`, zero outside the array.

    np.roll is wrong here: it wraps, which would let a tower on the east edge
    shade the west edge of the neighbourhood.
    """
    out = np.zeros_like(arr)
    h, w = arr.shape
    rs, re = max(0, -dr), min(h, h - dr)
    cs, ce = max(0, -dc), min(w, w - dc)
    if rs < re and cs < ce:
        out[rs:re, cs:ce] = arr[rs + dr : re + dr, cs + dc : ce + dc]
    return out


def _sweep_offsets(azimuth_deg: float, cell_m: float, max_m: float) -> list[tuple[int, int, float]]:
    """Cell offsets along an azimuth, with the ground distance of each step.

    Azimuth is clockwise from north, matching solar.py. Row 0 is the north
    edge, so travelling north means the row index falls.
    """
    a = math.radians(azimuth_deg)
    east, north = math.sin(a), math.cos(a)
    steps = []
    seen: set[tuple[int, int]] = set()
    n = int(max_m / cell_m)
    for k in range(1, n + 1):
        d = k * cell_m
        dc = int(round(east * d / cell_m))
        dr = int(round(-north * d / cell_m))
        if (dr, dc) in seen or (dr == 0 and dc == 0):
            continue
        seen.add((dr, dc))
        steps.append((dr, dc, d))
    return steps


def sky_view_factor(height: np.ndarray, cell_m: float = CELL_M) -> np.ndarray:
    """Fraction of the sky hemisphere visible from ground level in each cell.

    Hemispherical integration over `SVF_AZIMUTHS` equally spaced directions.
    For each direction the horizon angle is the largest elevation any obstacle
    subtends; the visible fraction in that direction is cos squared of it,
    which is the standard isotropic-sky result. SVF is their mean.

    A cell that is itself inside a building is not meaningful and is left at
    whatever the sweep gives; the caller masks those out, because nobody walks
    through a building.
    """
    horizon = np.zeros_like(height, dtype=np.float32)
    for i in range(SVF_AZIMUTHS):
        azimuth = 360.0 * i / SVF_AZIMUTHS
        best = np.zeros_like(height, dtype=np.float32)
        for dr, dc, distance in _sweep_offsets(azimuth, cell_m, MAX_OBSTRUCTION_M):
            obstacle = _shifted(height, dr, dc)
            np.maximum(best, obstacle / distance, out=best)   # tangent of the angle
        horizon += np.cos(np.arctan(best)) ** 2
    return (horizon / SVF_AZIMUTHS).astype(np.float32)


def sunlit_fraction(
    building_h: np.ndarray,
    canopy_h: np.ndarray,
    altitude_deg: float,
    azimuth_deg: float,
    cell_m: float = CELL_M,
) -> np.ndarray:
    """1 where the direct beam reaches the ground, 0 in building shadow, and
    the canopy transmissivity under a tree.

    Buildings and canopy are swept separately because they do different things
    to the beam: a wall blocks it, a crown attenuates it.
    """
    if altitude_deg <= 0:
        return np.zeros_like(building_h, dtype=np.float32)

    tan_alt = math.tan(math.radians(altitude_deg))
    in_building_shadow = np.zeros(building_h.shape, dtype=bool)
    under_canopy = np.zeros(building_h.shape, dtype=bool)

    for dr, dc, distance in _sweep_offsets(azimuth_deg, cell_m, MAX_OBSTRUCTION_M):
        beam_height = distance * tan_alt
        in_building_shadow |= _shifted(building_h, dr, dc) > beam_height
        under_canopy |= _shifted(canopy_h, dr, dc) > beam_height

    # A crown directly overhead shades its own cell, which no forward sweep
    # ever visits.
    under_canopy |= canopy_h > 0

    lit = np.ones(building_h.shape, dtype=np.float32)
    lit[under_canopy] = CANOPY_TRANSMISSIVITY
    lit[in_building_shadow] = 0.0   # a wall beats a crown
    return lit


def build(
    nta2020: str,
    building_h: np.ndarray,
    canopy_h: np.ndarray,
    inside_building: np.ndarray,
    origin_x: float,
    origin_y: float,
    when: datetime,
    altitude_deg: float,
    azimuth_deg: float,
    met: R.Meteorology,
    cell_m: float = CELL_M,
) -> ThermalGrid:
    """Assemble the MRT raster from the two height rasters."""
    svf = sky_view_factor(building_h, cell_m)
    lit = sunlit_fraction(building_h, canopy_h, altitude_deg, azimuth_deg, cell_m)
    mrt = R.mean_radiant_temperature(
        svf, lit, altitude_deg, azimuth_deg, when.timetuple().tm_yday, met,
    )

    # Cells occupied by a building are not walkable surface. Marking them NaN
    # keeps them from being sampled onto an edge that clips a building corner.
    mrt[inside_building] = np.nan

    return ThermalGrid(
        nta2020=nta2020,
        hour_local=when.hour,
        mrt=mrt,
        svf=svf,
        sunlit=lit,
        origin_x=origin_x,
        origin_y=origin_y,
        cell_m=cell_m,
        solar_altitude_deg=altitude_deg,
        solar_azimuth_deg=azimuth_deg,
    )


# ── encoding to the byte the OSWB v3 edge record carries ─────────────────────

MRT_OFFSET_C = 20.0
MRT_STEP_C = 0.5


def encode_mrt(celsius: np.ndarray) -> np.ndarray:
    """Quantise to the OSWB v3 byte. 0 is reserved for "not surveyed", so a
    NaN or an out-of-range value encodes as 0 and the router treats the edge
    as having no thermal information at all."""
    out = np.zeros(celsius.shape, dtype=np.uint8)
    good = np.isfinite(celsius)
    q = np.rint((celsius[good] - MRT_OFFSET_C) / MRT_STEP_C)
    q = np.clip(q, 1, 255)
    out[good] = q.astype(np.uint8)
    return out


def decode_mrt(byte: np.ndarray) -> np.ndarray:
    """Inverse of encode_mrt. 0 decodes to NaN, not to 20 C."""
    out = np.full(byte.shape, np.nan, dtype=np.float32)
    good = byte != 0
    out[good] = MRT_OFFSET_C + byte[good].astype(np.float32) * MRT_STEP_C
    return out


def demo() -> None:
    """Self-check the geometry on cases with a known answer."""
    # An open field sees the whole sky and takes the full beam.
    flat = np.zeros((21, 21), dtype=np.float32)
    svf = sky_view_factor(flat)
    assert np.allclose(svf, 1.0), f"open field SVF is {svf.mean():.3f}, expected 1"

    lit = sunlit_fraction(flat, flat, altitude_deg=58.0, azimuth_deg=240.0)
    assert np.all(lit == 1.0), "an open field at high sun must be fully lit"

    # Night is night.
    assert np.all(sunlit_fraction(flat, flat, -5.0, 240.0) == 0.0)

    # A tall wall along the whole eastern edge must shade cells to its west
    # when the sun is in the east, and leave them lit when the sun is west.
    wall = np.zeros((21, 21), dtype=np.float32)
    wall[:, 20] = 60.0
    east_sun = sunlit_fraction(wall, np.zeros_like(wall), altitude_deg=20.0, azimuth_deg=90.0)
    west_sun = sunlit_fraction(wall, np.zeros_like(wall), altitude_deg=20.0, azimuth_deg=270.0)
    assert east_sun[10, 10] == 0.0, "the wall is between this cell and an eastern sun"
    assert west_sun[10, 10] == 1.0, "a western sun is not blocked by an eastern wall"

    # Shadows shorten as the sun climbs.
    low = sunlit_fraction(wall, np.zeros_like(wall), 10.0, 90.0)
    high = sunlit_fraction(wall, np.zeros_like(wall), 70.0, 90.0)
    assert low.sum() < high.sum(), "a low sun must cast the longer shadow"

    # A courtyard sees less sky than the open field around it.
    court = np.zeros((31, 31), dtype=np.float32)
    court[10:21, 10:21] = 40.0
    court[15, 15] = 0.0           # the well itself
    svf_court = sky_view_factor(court)
    assert svf_court[15, 15] < 0.35, f"courtyard SVF {svf_court[15, 15]:.3f} is too open"
    assert svf_court[0, 0] > 0.9, "the far corner should still see open sky"

    # Canopy attenuates rather than blocks, and a wall beats a crown.
    canopy = np.zeros((21, 21), dtype=np.float32)
    canopy[10, 10] = 8.0
    shaded = sunlit_fraction(np.zeros_like(canopy), canopy, 58.0, 240.0)
    assert shaded[10, 10] == CANOPY_TRANSMISSIVITY
    both = sunlit_fraction(wall, canopy, 20.0, 90.0)
    assert both[10, 10] == 0.0, "a building shadow must win over canopy"

    # The byte round trip, including the reserved zero.
    probe = np.array([np.nan, 20.0, 25.0, 40.25, 62.0, 200.0], dtype=np.float32)
    back = decode_mrt(encode_mrt(probe))
    assert np.isnan(back[0]), "only a non-finite value may become 'not surveyed'"
    for i in (2, 3, 4):
        assert abs(back[i] - probe[i]) <= 0.25, (probe[i], back[i])
    # Out-of-range values clamp to the ends of the scale rather than wrapping,
    # and, more importantly, rather than landing on 0, which would silently downgrade a
    # surveyed edge to unknown.
    assert back[1] == MRT_OFFSET_C + MRT_STEP_C, f"20 C should clamp to the floor, got {back[1]}"
    assert back[5] == MRT_OFFSET_C + 255 * MRT_STEP_C, "out of range must clamp, not wrap"
    assert np.all(encode_mrt(np.array([-40.0, 1e9], np.float32)) != 0), (
        "a finite reading must never encode to the unknown sentinel"
    )

    # Sampling picks the right cell and refuses to extrapolate.
    g = ThermalGrid("TEST", 15, np.array([[40.0, 50.0], [60.0, 70.0]], np.float32),
                    np.zeros((2, 2), np.float32), np.zeros((2, 2), np.float32),
                    origin_x=1000.0, origin_y=2000.0, cell_m=10.0,
                    solar_altitude_deg=58.0, solar_azimuth_deg=240.0)
    xs = np.array([1005.0, 1015.0, 1005.0, 900.0])
    ys = np.array([1995.0, 1995.0, 1985.0, 1995.0])
    got = g.sample(xs, ys)
    assert got[0] == 40.0 and got[1] == 50.0 and got[2] == 60.0, got
    assert np.isnan(got[3]), "a point west of the raster must be unknown"

    print("grid.py self-check passed")


if __name__ == "__main__":
    demo()
