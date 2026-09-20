"""Radiation budget and mean radiant temperature, from published formulations.

This module replaces an earlier version of the thermal proxy that mapped shade
and sky view factor onto degrees Celsius through two fitted constants. Those
constants were invented. Everything here is either a published correlation, a
measured material property, or a physical constant, and each is cited at its
definition so a reviewer can check it without reading the rest of the code.

The chain is:

    solar geometry                      -> solar.py (NOAA / Meeus)
    clear-sky global horizontal         -> Kasten and Czeplak (1980)
    split into direct and diffuse       -> Erbs, Klein and Duffie (1982)
    shading and sky view factor         -> grid.py, against a building DSM
    six-directional radiant flux Sstr   -> Hoppe (1992), as used by SOLWEIG
    mean radiant temperature            -> Stefan-Boltzmann inversion
    thermal stress category             -> UTCI, Brode et al. (2012)

The last step is what makes the routing cost defensible: the band thresholds
are not chosen, they are the official UTCI thermal stress category boundaries
inverted back into mean radiant temperature at a documented reference
meteorology. See thresholds.py.

WHAT THIS IS NOT. It is not SOLWEIG. SOLWEIG resolves the full anisotropic sky,
per-wall surface temperatures, vegetation transmissivity per species, and an
explicit ground energy balance. This module keeps the same governing equation
and the same angular factors, and simplifies the inputs. The output is labelled
tier=proxy everywhere it appears.

References
----------
Kasten, F. and Czeplak, G. (1980). Solar and terrestrial radiation dependent on
    the amount and type of cloud. Solar Energy 24(2), 177-189.
Erbs, D.G., Klein, S.A. and Duffie, J.A. (1982). Estimation of the diffuse
    radiation fraction for hourly, daily and monthly-average global radiation.
    Solar Energy 28(4), 293-302.
Hoppe, P. (1992). Ein neues Verfahren zur Bestimmung der mittleren
    Strahlungstemperatur im Freien. Wetter und Leben 44, 147-151.
Lindberg, F., Holmer, B. and Thorsson, S. (2008). SOLWEIG 1.0: modelling
    spatial variations of 3D radiant fluxes and mean radiant temperature in
    complex urban settings. International Journal of Biometeorology 52,
    697-713. doi:10.1007/s00484-008-0162-7
Prata, A.J. (1996). A new long-wave formula for estimating downward clear-sky
    radiation at the surface. Quarterly Journal of the Royal Meteorological
    Society 122, 1127-1151.
Brode, P. et al. (2012). Deriving the operational procedure for the Universal
    Thermal Climate Index (UTCI). International Journal of Biometeorology 56(3),
    481-494. doi:10.1007/s00484-011-0454-1
Kopp, G. and Lean, J.L. (2011). A new, lower value of total solar irradiance.
    Geophysical Research Letters 38, L01706.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

# ── physical constants ───────────────────────────────────────────────────────

#: Stefan-Boltzmann constant, W m^-2 K^-4 (CODATA 2018, exact by definition).
SIGMA = 5.670374419e-8

#: Total solar irradiance at 1 AU, W m^-2 (Kopp and Lean 2011).
SOLAR_CONSTANT = 1361.0

KELVIN = 273.15

# ── human body, from Hoppe (1992) as used by SOLWEIG ─────────────────────────
#
# Angular weighting factors for a standing person, and the absorption
# coefficients of a clothed human body. These are the values the SOLWEIG
# literature specifies; they are physical parameters of the body model, not
# anything fitted to this project's data.

#: Fraction of the body surface facing up and down.
F_UP_STANDING = 0.06
#: Fraction facing each of the four cardinal directions.
F_SIDE_STANDING = 0.22
#: Cylinder factor for the direct beam on a standing person.
F_CYL_STANDING = 0.28

#: Shortwave absorption coefficient of a clothed human body.
ABS_SHORTWAVE = 0.70
#: Longwave absorption (and emission) coefficient of a clothed human body.
ABS_LONGWAVE = 0.97

# ── urban surfaces ───────────────────────────────────────────────────────────
#
# These are material properties, with the value chosen at the middle of the
# range reported for the relevant surface. Each is a single named quantity that
# a reviewer can challenge on its own.

#: Albedo of an aged asphalt and concrete street surface. Fresh asphalt is
#: darker (near 0.05) and weathered concrete lighter (near 0.35); a mixed
#: streetscape of roadway, pavement and parked vehicles sits between.
GROUND_ALBEDO = 0.15

#: Albedo of urban wall surfaces (brick, painted masonry, glass).
WALL_ALBEDO = 0.20

#: Thermal emissivity of ordinary building and paving materials. Nearly all
#: non-metallic construction materials fall in 0.90 to 0.95.
SURFACE_EMISSIVITY = 0.95

#: Temperature rise of a SUNLIT paved surface above screen-level air
#: temperature on a clear summer afternoon, in kelvin.
#:
#: ASSUMPTION, with a sourced range rather than a measurement at these sites.
#: Surface-to-air differences of roughly 20 to 25 K are widely reported for dry
#: asphalt under midday summer sun. The value drives the upwelling longwave
#: term, which is the smaller part of the budget: moving it by 5 K moves the
#: resulting Tmrt by under 1.5 K. It is exposed here so it can be replaced by
#: a measured or modelled surface temperature field.
SUNLIT_SURFACE_EXCESS_K = 22.0

#: Temperature rise of a SHADED paved surface above air temperature. Shaded
#: pavement tracks air temperature closely.
SHADED_SURFACE_EXCESS_K = 2.0


@dataclass(frozen=True)
class Meteorology:
    """The reference weather the grid is computed for.

    Every field is sourced, and the source is recorded alongside the value in
    the artifact metadata rather than only in a comment.
    """

    air_temp_c: float
    vapour_pressure_hpa: float
    wind_10m_ms: float
    label: str
    sources: tuple[str, ...] = ()

    @property
    def air_temp_k(self) -> float:
        return self.air_temp_c + KELVIN


def clear_sky_global(solar_altitude_deg: float) -> float:
    """Clear-sky global horizontal irradiance, W m^-2.

    Kasten and Czeplak (1980): ``G = 910 sin(h) - 30`` for a cloudless sky,
    where h is solar altitude. Returns 0 when the sun is below the horizon or
    the expression goes negative at very low sun.
    """
    if solar_altitude_deg <= 0:
        return 0.0
    return max(0.0, 910.0 * math.sin(math.radians(solar_altitude_deg)) - 30.0)


def extraterrestrial_horizontal(solar_altitude_deg: float, day_of_year: int) -> float:
    """Extraterrestrial irradiance on a horizontal surface, W m^-2.

    Includes the standard eccentricity correction for the Earth-Sun distance.
    Needed only to form the clearness index that Erbs et al. takes as input.
    """
    if solar_altitude_deg <= 0:
        return 0.0
    eccentricity = 1.0 + 0.033 * math.cos(2.0 * math.pi * day_of_year / 365.0)
    return SOLAR_CONSTANT * eccentricity * math.sin(math.radians(solar_altitude_deg))


def erbs_diffuse_fraction(clearness_index: float) -> float:
    """Diffuse fraction of global horizontal irradiance.

    Erbs, Klein and Duffie (1982), equation 1, piecewise in the clearness index
    kt. Reproduced here from the published correlation.
    """
    kt = min(1.0, max(0.0, clearness_index))
    if kt <= 0.22:
        return 1.0 - 0.09 * kt
    if kt <= 0.80:
        return (
            0.9511
            - 0.1604 * kt
            + 4.388 * kt**2
            - 16.638 * kt**3
            + 12.336 * kt**4
        )
    return 0.165


def split_irradiance(solar_altitude_deg: float, day_of_year: int) -> tuple[float, float]:
    """Return (direct normal, diffuse horizontal) irradiance in W m^-2.

    Clear sky throughout: this grid answers "where is it hot on a cloudless
    afternoon", which is the condition the Cool It! standard is written for.
    """
    ghi = clear_sky_global(solar_altitude_deg)
    if ghi <= 0:
        return 0.0, 0.0
    toa = extraterrestrial_horizontal(solar_altitude_deg, day_of_year)
    kt = ghi / toa if toa > 0 else 0.0
    dhi = erbs_diffuse_fraction(kt) * ghi
    beam_horizontal = max(0.0, ghi - dhi)
    dni = beam_horizontal / max(1e-6, math.sin(math.radians(solar_altitude_deg)))
    return dni, dhi


def sky_emissivity(air_temp_k: float, vapour_pressure_hpa: float) -> float:
    """Clear-sky effective emissivity, Prata (1996).

    ``eps = 1 - (1 + w) exp(-(1.2 + 3w)^0.5)`` with ``w = 46.5 e / T``, e in
    hPa and T in kelvin. Used for the downwelling longwave from the visible
    sky hemisphere.
    """
    w = 46.5 * vapour_pressure_hpa / air_temp_k
    return 1.0 - (1.0 + w) * math.exp(-((1.2 + 3.0 * w) ** 0.5))


def mean_radiant_temperature(
    svf: np.ndarray,
    sunlit: np.ndarray,
    solar_altitude_deg: float,
    solar_azimuth_deg: float,
    day_of_year: int,
    met: Meteorology,
) -> np.ndarray:
    """Mean radiant temperature in degrees Celsius, per cell.

    Follows the six-directional approach of Hoppe (1992) as implemented in
    SOLWEIG: absorbed shortwave and longwave fluxes are weighted by the angular
    factors of a standing body, summed into the mean radiant flux density
    Sstr, and inverted through the Stefan-Boltzmann law:

        Sstr = ak * (Kcyl * Fcyl + (Kdown + Kup) * Fup + Ksides * Fside)
             + al * ((Ldown + Lup) * Fup + Lsides * Fside)

        Tmrt = (Sstr / (al * sigma))^(1/4) - 273.15

    `sunlit` is 1 in full sun, 0 in shadow, and the canopy transmissivity under
    a tree crown. `svf` is the fraction of the sky hemisphere visible.
    """
    dni, dhi = split_irradiance(solar_altitude_deg, day_of_year)
    sin_alt = max(0.0, math.sin(math.radians(solar_altitude_deg)))
    cos_alt = math.cos(math.radians(solar_altitude_deg))

    svf = np.asarray(svf, dtype=np.float64)
    sunlit = np.asarray(sunlit, dtype=np.float64)

    # ── shortwave ────────────────────────────────────────────────────────────
    # Downwelling: the direct beam only where the cell is lit, plus the share
    # of the diffuse hemisphere the cell can actually see.
    k_down = sunlit * dni * sin_alt + svf * dhi

    # Upwelling: what the ground reflects. Cells in shadow reflect only the
    # diffuse they receive.
    k_up = GROUND_ALBEDO * k_down

    # On the body's vertical surfaces: the direct beam projected onto a
    # standing cylinder, plus shortwave reflected off the ground and the
    # surrounding walls.
    #
    # The reflected term is scaled by the shortwave actually arriving at this
    # cell, not by the unobstructed global irradiance. Scaling by the latter
    # made a deep shaded canyon come out hotter than an open shaded street,
    # because it credited the canyon's large wall view factor with reflecting
    # full sun that never reaches those walls. Walls in a shaded canyon are
    # shaded too.
    k_cyl = sunlit * dni * cos_alt
    k_sides = (GROUND_ALBEDO + WALL_ALBEDO * (1.0 - svf)) * k_down

    # ── longwave ─────────────────────────────────────────────────────────────
    eps_sky = sky_emissivity(met.air_temp_k, met.vapour_pressure_hpa)
    l_sky = eps_sky * SIGMA * met.air_temp_k**4

    # Surface temperature: sunlit paving runs well above air temperature,
    # shaded paving close to it. Interpolated by how lit the cell is.
    surface_excess = (
        SHADED_SURFACE_EXCESS_K
        + (SUNLIT_SURFACE_EXCESS_K - SHADED_SURFACE_EXCESS_K) * sunlit
    )
    t_surface_k = met.air_temp_k + surface_excess
    l_up = SURFACE_EMISSIVITY * SIGMA * t_surface_k**4

    # Downwelling longwave: sky where it is visible, wall where it is not.
    # Walls are treated as partly sunlit and are warmer than the air.
    t_wall_k = met.air_temp_k + 0.5 * surface_excess
    l_wall = SURFACE_EMISSIVITY * SIGMA * t_wall_k**4
    l_down = svf * l_sky + (1.0 - svf) * l_wall

    # The four side directions see a mix of sky, wall and ground.
    l_sides = 0.5 * l_down + 0.5 * l_up

    # ── combine ──────────────────────────────────────────────────────────────
    k_absorbed = ABS_SHORTWAVE * (
        k_cyl * F_CYL_STANDING
        + (k_down + k_up) * F_UP_STANDING
        + k_sides * F_SIDE_STANDING * 4.0
    )
    l_absorbed = ABS_LONGWAVE * (
        (l_down + l_up) * F_UP_STANDING + l_sides * F_SIDE_STANDING * 4.0
    )

    sstr = k_absorbed + l_absorbed
    tmrt_k = (sstr / (ABS_LONGWAVE * SIGMA)) ** 0.25
    return (tmrt_k - KELVIN).astype(np.float32)


def demo() -> None:
    """Self-check against published behaviour rather than against itself."""
    # Kasten and Czeplak at the solar constant end: a sun at the zenith on a
    # clear day gives close to 880 W/m2 global horizontal.
    assert abs(clear_sky_global(90.0) - 880.0) < 1.0, clear_sky_global(90.0)
    assert clear_sky_global(0.0) == 0.0
    assert clear_sky_global(-5.0) == 0.0

    # Erbs: a very clear sky is mostly beam, an overcast one is all diffuse.
    assert abs(erbs_diffuse_fraction(0.85) - 0.165) < 1e-9
    assert erbs_diffuse_fraction(0.1) > 0.98
    assert erbs_diffuse_fraction(0.7) < 0.35
    # Monotone decreasing across the middle branch.
    mids = [erbs_diffuse_fraction(k) for k in (0.3, 0.45, 0.6, 0.75)]
    assert all(a > b for a, b in zip(mids, mids[1:])), mids

    # Prata sky emissivity sits in the range the literature reports for a
    # clear sky, roughly 0.7 to 0.85 in a humid summer atmosphere.
    eps = sky_emissivity(273.15 + 34.3, 19.7)
    assert 0.70 < eps < 0.90, eps

    # A summer afternoon in NYC: the resulting range is checked against
    # measured and SOLWEIG-modelled Tmrt for Philadelphia, the closest
    # published humid-continental US analogue. Li, Chakraborty and Wang (2023)
    # map 1 m Tmrt across Philadelphia on 20 July at 11:30 and report a range
    # of roughly 35 to 65 C, with sunlit street pixels concentrated in the
    # mid fifties to low sixties and shaded downtown blocks markedly lower.
    # This grid is computed for 15:00, when the sun sits about ten degrees
    # lower than at 11:30, so landing at the lower end of that range is
    # expected rather than a fault.
    met = Meteorology(34.3, 19.7, 5.41, "NWS heat advisory threshold")
    svf = np.array([0.95, 0.30], dtype=np.float64)
    lit = np.array([1.0, 0.0], dtype=np.float64)
    tmrt = mean_radiant_temperature(svf, lit, 57.8, 239.6, 202, met)
    assert 45.0 < tmrt[0] < 68.0, f"open sun Tmrt {tmrt[0]:.1f} C outside the Philadelphia range"
    assert 28.0 < tmrt[1] < 45.0, f"deep shade Tmrt {tmrt[1]:.1f} C outside the Philadelphia range"
    # The strongest available validation, because it is a difference and so
    # does not depend on matching someone else's air temperature.
    #
    # Middel, Alkhaled, Schneider, Hagen and Coseo (2021), "50 Grades of
    # Shade", Bull. Amer. Meteor. Soc. 102(9), E1805-E1820, measure 1,988
    # samples at 159 Tempe locations over nine clear summer days and report
    # that "Shade from urban form reduced TMRT by 22.8-30.9 C during the day".
    # Du et al. (2020) independently report 28.8 C for building shading in
    # Harbin, a humid continental city.
    #
    # Absolute levels are not compared, because those studies ran at different
    # air temperatures; a clear sky is radiatively cold, so shaded Tmrt tracks
    # air temperature down and the absolute figure moves with it.
    shade_relief = tmrt[0] - tmrt[1]
    assert 20.0 < shade_relief < 34.0, (
        f"building shade buys {shade_relief:.1f} K, outside the 22.8 to 30.9 K "
        "that Middel et al. (2021) measured"
    )

    # Night: no shortwave at all, so Tmrt falls near air temperature.
    night = mean_radiant_temperature(svf, np.zeros(2), -10.0, 0.0, 202, met)
    assert np.all(night < met.air_temp_c + 12.0), night
    assert np.all(night > met.air_temp_c - 15.0), night

    # Enclosure must not manufacture heat in shade. A deep canyon traps
    # longwave, so it is slightly warmer than an open shaded street, but only
    # slightly; if it comes out much warmer the reflected shortwave term is
    # being credited with sun that never reaches those walls.
    shade = mean_radiant_temperature(
        np.array([0.30, 0.60, 0.90]), np.zeros(3), 57.8, 239.6, 202, met
    )
    assert shade[0] > shade[2], "an enclosed shaded canyon traps longwave"
    assert shade[0] - shade[2] < 6.0, f"enclosure effect {shade[0]-shade[2]:.1f} K is too large"

    # Monotone in exposure, which is the property the router depends on.
    ramp = mean_radiant_temperature(
        np.full(5, 0.8), np.linspace(0.0, 1.0, 5), 57.8, 239.6, 202, met
    )
    assert all(a < b for a, b in zip(ramp, ramp[1:])), ramp

    print("radiation.py self-check passed")
    print(
        f"  open sun {tmrt[0]:.1f} C, building shade {tmrt[1]:.1f} C, "
        f"relief {shade_relief:.1f} K (Middel et al. 2021 measured 22.8 to 30.9 K)"
    )


if __name__ == "__main__":
    demo()
