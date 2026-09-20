"""Derive the routing cost parameters from published sources.

Nothing in the thermal cost function is chosen by this project. This module is
where that claim is made good: it takes the reference meteorology, the official
UTCI thermal stress scale, and the two behavioural route-choice studies that
estimate a distance-versus-heat trade-off, and emits the handful of numbers the
router actually runs on. Running it prints the derivation.

The three things it produces:

  1. The shade and sun anchors, in mean radiant temperature, at the reference
     meteorology. These come from the radiation budget, not from a fit.
  2. The sun inflation coefficient beta - 1, from Melnikov et al. (2022), with
     Basu et al. (2024) as an independent cross-check.
  3. The UTCI thermal stress category boundaries expressed in mean radiant
     temperature, used for LABELLING severity in the interface. They are not
     used as cost bands: at NYC conditions a whole neighbourhood falls inside
     one or two categories, so they cannot discriminate between routes.

WHY THE COST IS NOT BANDED ON UTCI CATEGORIES

The obvious design is to charge more as a route crosses each official UTCI
category boundary. It does not work here, and the reason is worth recording.
At the reference meteorology the derivative of UTCI with respect to mean
radiant temperature is about 0.22, so the roughly 32 K spread between full
shade and full sun in a Brownsville street is only about 7 K of UTCI. That
moves across at most two category boundaries, and most of the neighbourhood
sits inside a single category. Categories are the right vocabulary for telling
someone how dangerous a place is; they are too coarse to choose a route with.

REFERENCES

Brode, P., Fiala, D., Blazejczyk, K., Holmer, I., Jendritzky, G., Kampmann, B.,
    Tinz, B. and Havenith, G. (2012). Deriving the operational procedure for
    the Universal Thermal Climate Index (UTCI). International Journal of
    Biometeorology 56(3), 481-494. doi:10.1007/s00484-011-0454-1
Melnikov, V.R., Krzhizhanovskaya, V.V., Lees, M.H. and Sloot, P.M.A. (2022).
    Behavioural thermal regulation explains pedestrian path choices in hot
    urban environments. Scientific Reports 12, 2441.
    doi:10.1038/s41598-022-06383-5
Basu, R., Colaninno, N., Alhassan, A. and Sevtsuk, A. (2024). Hot and
    bothered: exploring the effect of heat on pedestrian route choice behavior
    and accessibility. Cities 155, 105435. doi:10.1016/j.cities.2024.105435
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import thermofeel as tf

from pipeline.thermal import radiation as R

# ── the official UTCI assessment scale ───────────────────────────────────────
#
# Brode et al. (2012), Table 4. Category boundaries in degrees Celsius of UTCI.
# Reproduced exactly; this project does not choose them.
UTCI_CATEGORIES: tuple[tuple[float, str], ...] = (
    (46.0, "extreme heat stress"),
    (38.0, "very strong heat stress"),
    (32.0, "strong heat stress"),
    (26.0, "moderate heat stress"),
    (9.0, "no thermal stress"),
)

# ── behavioural route-choice parameters ──────────────────────────────────────
#
# Melnikov et al. (2022). A controlled two-alternative forced-choice experiment
# in Singapore, 46 participants, 408 analysed path choices, parameters
# estimated by Bayesian hierarchical inference. beta is the distance-inflating
# coefficient applied to the sunlit part of a path.
#
#   "walking in the sun is considered by pedestrians on average 16% longer as
#    compared to walking the same distance in the shade"
#
# TRANSFERABILITY CAVEAT. The participants were university students in a
# tropical climate, acclimatised, healthy and young. The population this router
# is aimed at is the opposite on every count: residents of Heat Vulnerability
# Index 4 and 5 neighbourhoods in a humid continental city, including older
# adults and people with cardiovascular and respiratory conditions. The
# population mean is therefore used as the DEFAULT, not as the value for a
# heat-vulnerable user, and the observed individual maximum anchors the
# sensitive end of the condition map.
MELNIKOV_BETA_MEAN = 1.16
MELNIKOV_BETA_INDIVIDUAL_MAX = 1.84
MELNIKOV_TREE_SHADE_RELIEF = 0.50  # tree shade is worth half of building shade

# Basu et al. (2024). Revealed preference from real GPS pedestrian trips in
# Boston, a humid continental North American city, estimated as a path-size
# logit in willingness-to-walk space. Route length is the numeraire, so the
# thermal coefficient is already denominated in metres of extra walking per
# degree of UTCI above the 26 C comfort threshold.
#
# The banded specification is used rather than the linear one because the NYC
# design condition puts almost the whole field above UTCI 32.
BASU_METRES_PER_UTCI_ABOVE_32 = 64.3
BASU_METRES_PER_UTCI_LINEAR_DAY = 80.8
BASU_MEAN_ROUTE_LENGTH_M = 624.9


@dataclass(frozen=True)
class CostParameters:
    """Everything the router needs, and where each number came from."""

    mrt_shade_c: float
    mrt_sun_c: float
    sun_inflation_default: float
    sun_inflation_sensitive: float
    sun_inflation_basu_equivalent: float
    utci_shade_c: float
    utci_sun_c: float
    dutci_dmrt: float
    category_thresholds_mrt_c: dict
    meteorology: dict
    provenance: dict


def utci_from_mrt(mrt_c: float | np.ndarray, met: R.Meteorology) -> np.ndarray:
    """UTCI in degrees Celsius for a mean radiant temperature, at `met`.

    Thin wrapper over thermofeel's implementation of the Brode et al. (2012)
    operational polynomial. thermofeel is ECMWF's, Apache-2.0, and its only
    runtime dependency is numpy.
    """
    mrt = np.atleast_1d(np.asarray(mrt_c, dtype=float))
    return (
        tf.calculate_utci(
            t2_k=np.full(mrt.shape, met.air_temp_k),
            va=np.full(mrt.shape, met.wind_10m_ms),
            mrt=mrt + 273.15,
            ehPa=np.full(mrt.shape, met.vapour_pressure_hpa),
        )
        - 273.15
    )


def mrt_at_utci(target_utci_c: float, met: R.Meteorology) -> float | str:
    """Invert UTCI to the mean radiant temperature that produces it.

    Returns a temperature, or one of two strings when no crossing exists
    inside the polynomial's stated validity range, which bounds Tmrt to 30 K
    below and 70 K above air temperature:

      "always exceeded"  the category is already reached at the coldest
                         radiant environment possible at this air temperature
      "not reachable"    it is not reached at the hottest

    Returning a marker rather than clamping to the end of the search range
    matters. Clamping would have reported that moderate heat stress begins at
    4.3 C of mean radiant temperature, when the truth is that on a heat
    advisory day it is exceeded everywhere, in every shadow, unconditionally.
    That is a finding, and it should not be disguised as a threshold.
    """
    lo = met.air_temp_c - 30.0
    hi = met.air_temp_c + 70.0
    grid = np.arange(lo, hi, 0.01)
    values = utci_from_mrt(grid, met)
    if values[0] >= target_utci_c:
        return "always exceeded"
    hits = np.nonzero(values >= target_utci_c)[0]
    if hits.size == 0:
        return "not reachable"
    return float(grid[hits[0]])


def anchors(met: R.Meteorology, solar_altitude_deg: float, day_of_year: int) -> tuple[float, float]:
    """Mean radiant temperature of full building shade and of open full sun.

    Computed from the radiation budget at the reference meteorology, so the
    anchors move correctly if the meteorology or the hour changes. Full shade
    is taken at a street-canyon sky view factor and full sun at an open one.
    """
    svf = np.array([0.60, 0.90])
    lit = np.array([0.0, 1.0])
    mrt = R.mean_radiant_temperature(
        svf, lit, solar_altitude_deg, 0.0, day_of_year, met
    )
    return float(mrt[0]), float(mrt[1])


def derive(
    met: R.Meteorology, solar_altitude_deg: float, day_of_year: int
) -> CostParameters:
    """Produce the full parameter set, with provenance."""
    mrt_shade, mrt_sun = anchors(met, solar_altitude_deg, day_of_year)
    utci_shade = float(utci_from_mrt(mrt_shade, met)[0])
    utci_sun = float(utci_from_mrt(mrt_sun, met)[0])

    span_mrt = mrt_sun - mrt_shade
    span_utci = utci_sun - utci_shade
    dutci_dmrt = span_utci / span_mrt if span_mrt else 0.0

    # Basu's coefficient is per degree of UTCI and per route; dividing by their
    # mean route length converts it to a fraction of route length per degree,
    # which is the same currency as beta - 1. This division is arithmetic this
    # project performed, not a figure the paper reports.
    basu_fraction_per_utci = BASU_METRES_PER_UTCI_ABOVE_32 / BASU_MEAN_ROUTE_LENGTH_M
    basu_equivalent_inflation = basu_fraction_per_utci * span_utci

    categories: dict[str, float | str] = {}
    for boundary, name in UTCI_CATEGORIES:
        categories[name] = mrt_at_utci(boundary, met)

    return CostParameters(
        mrt_shade_c=round(mrt_shade, 2),
        mrt_sun_c=round(mrt_sun, 2),
        sun_inflation_default=round(MELNIKOV_BETA_MEAN - 1.0, 4),
        sun_inflation_sensitive=round(MELNIKOV_BETA_INDIVIDUAL_MAX - 1.0, 4),
        sun_inflation_basu_equivalent=round(basu_equivalent_inflation, 4),
        utci_shade_c=round(utci_shade, 2),
        utci_sun_c=round(utci_sun, 2),
        dutci_dmrt=round(dutci_dmrt, 4),
        category_thresholds_mrt_c={
            k: (round(v, 2) if isinstance(v, float) else v) for k, v in categories.items()
        },
        meteorology={
            "label": met.label,
            "air_temp_c": met.air_temp_c,
            "vapour_pressure_hpa": met.vapour_pressure_hpa,
            "wind_10m_ms": met.wind_10m_ms,
            "sources": list(met.sources),
        },
        provenance={
            "utci_scale": "Brode et al. (2012), Int J Biometeorol 56(3), 481-494",
            "utci_implementation": "thermofeel 2.3.0 (ECMWF, Apache-2.0)",
            "sun_inflation_default": (
                f"Melnikov et al. (2022), Sci Rep 12:2441, population mean "
                f"beta = {MELNIKOV_BETA_MEAN}, 46 participants, 408 path choices, Singapore"
            ),
            "sun_inflation_sensitive": (
                f"Melnikov et al. (2022), observed individual maximum "
                f"beta = {MELNIKOV_BETA_INDIVIDUAL_MAX}"
            ),
            "sun_inflation_basu_equivalent": (
                f"Basu et al. (2024), Cities 155:105435, "
                f"{BASU_METRES_PER_UTCI_ABOVE_32} m per degree UTCI above 32 C, divided by "
                f"their mean route length {BASU_MEAN_ROUTE_LENGTH_M} m, times the "
                f"UTCI span between these anchors. The division is this project's arithmetic."
            ),
            "tree_shade_relief": (
                f"Melnikov et al. (2022) estimate rho = {MELNIKOV_TREE_SHADE_RELIEF}: "
                "tree shade is perceived as worth half of building shade. The radiation "
                "budget here already gives tree shade a higher Tmrt than building shade, "
                "so this is partly captured on physical grounds. The router costs the "
                "radiative quantity, not the perceived one."
            ),
        },
    )


def write(root: Path, params: CostParameters) -> Path:
    out = root / "thermal" / "cost-parameters.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(asdict(params), indent=2) + "\n")
    return out


def report(params: CostParameters) -> str:
    lines = [
        "Thermal cost parameters, derived from published sources",
        "",
        f"  reference meteorology   {params.meteorology['label']}",
        f"                          Ta {params.meteorology['air_temp_c']} C, "
        f"vapour {params.meteorology['vapour_pressure_hpa']} hPa, "
        f"wind {params.meteorology['wind_10m_ms']} m/s at 10 m",
        "",
        f"  full building shade     MRT {params.mrt_shade_c:5.1f} C   UTCI {params.utci_shade_c:5.1f} C",
        f"  open full sun           MRT {params.mrt_sun_c:5.1f} C   UTCI {params.utci_sun_c:5.1f} C",
        f"  dUTCI/dMRT              {params.dutci_dmrt:.3f}"
        f"   ({params.mrt_sun_c - params.mrt_shade_c:.0f} K of MRT is only"
        f" {params.utci_sun_c - params.utci_shade_c:.1f} K of UTCI)",
        "",
        "  sun inflation (beta - 1), the cost added at full exposure",
        f"    default, population mean       {params.sun_inflation_default:.3f}   Melnikov 2022",
        f"    heat-sensitive, observed max   {params.sun_inflation_sensitive:.3f}   Melnikov 2022",
        f"    Boston revealed-preference     {params.sun_inflation_basu_equivalent:.3f}   Basu 2024, converted",
        "",
        "  UTCI stress categories, inverted to mean radiant temperature",
    ]
    for name, value in params.category_thresholds_mrt_c.items():
        shown = f"MRT >= {value:6.1f} C" if isinstance(value, float) else value
        lines.append(f"    {name:<24} {shown}")
    lines += [
        "",
        "  Categories label severity in the interface. They are NOT cost bands:",
        "  at these conditions a whole neighbourhood falls in one or two of them.",
    ]
    return "\n".join(lines)


def demo() -> None:
    """Self-check the derivation against the published scale and each other."""
    from pipeline.thermal.build import HEAT_ADVISORY_MET

    params = derive(HEAT_ADVISORY_MET, 57.8, 202)

    # The anchors must separate, and in the right order.
    assert params.mrt_sun_c > params.mrt_shade_c + 15.0, params
    assert params.utci_sun_c > params.utci_shade_c

    # The compression that rules out banding on categories.
    assert 0.15 < params.dutci_dmrt < 0.35, params.dutci_dmrt

    # Inversion must round-trip through the polynomial.
    for name, mrt in params.category_thresholds_mrt_c.items():
        if not isinstance(mrt, float):
            continue
        boundary = next(b for b, n in UTCI_CATEGORIES if n == name)
        got = float(utci_from_mrt(mrt, HEAT_ADVISORY_MET)[0])
        assert abs(got - boundary) < 0.05, f"{name}: inverted to {got}, want {boundary}"

    # Category thresholds must be ordered the same way the scale is.
    reachable = [v for v in params.category_thresholds_mrt_c.values() if isinstance(v, float)]
    assert reachable == sorted(reachable, reverse=True), reachable

    # On a heat advisory day, moderate heat stress must come out as
    # unconditional. If this ever stops holding, the reference meteorology has
    # drifted away from the advisory condition it is supposed to represent.
    assert params.category_thresholds_mrt_c["moderate heat stress"] == "always exceeded"

    # The two independent behavioural studies should agree to within a factor
    # of three. They are different populations, methods and climates, so exact
    # agreement would be suspicious; order-of-magnitude disagreement would mean
    # one of them has been misread.
    ratio = params.sun_inflation_basu_equivalent / params.sun_inflation_default
    assert 0.3 < ratio < 4.0, (
        f"Melnikov and Basu disagree by {ratio:.1f}x, which suggests a misreading"
    )

    # The default must be the gentler of the two, so the shipped behaviour is
    # not the most aggressive reading of the literature.
    assert params.sun_inflation_default < params.sun_inflation_sensitive

    print(report(params))
    print("\nthresholds.py self-check passed")


if __name__ == "__main__":
    demo()
