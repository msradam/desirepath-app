"""Solar position, NOAA's low-precision algorithm.

Accurate to about 0.01 degrees for dates near the present, which is far tighter
than anything the 4 m thermal grid can resolve. Implemented here rather than
pulled in as a dependency because it is forty lines of arithmetic and the
dependency-provenance policy says reuse beats addition.

Reference: NOAA Global Monitoring Laboratory solar calculator, itself after
Jean Meeus, "Astronomical Algorithms", 2nd ed., chapters 12, 22, 25.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone


def _julian_day(dt: datetime) -> float:
    """Julian day number for a timezone-aware datetime."""
    dt = dt.astimezone(timezone.utc)
    y, m = dt.year, dt.month
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    day = (
        dt.day
        + (dt.hour + dt.minute / 60.0 + dt.second / 3600.0) / 24.0
    )
    return (
        math.floor(365.25 * (y + 4716))
        + math.floor(30.6001 * (m + 1))
        + day
        + b
        - 1524.5
    )


def solar_position(dt: datetime, lat_deg: float, lon_deg: float) -> tuple[float, float]:
    """Return (altitude, azimuth) in degrees.

    Altitude is measured up from the horizon; negative means the sun is down.
    Azimuth is measured clockwise from true north, so 90 is due east and 180 is
    due south. This is the convention the shadow sweep in grid.py expects.
    """
    jd = _julian_day(dt)
    t = (jd - 2451545.0) / 36525.0  # Julian centuries since J2000.0

    # Geometric mean longitude and anomaly of the sun.
    mean_long = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360.0
    mean_anom = 357.52911 + t * (35999.05029 - 0.0001537 * t)

    # Equation of the centre, then true longitude.
    m = math.radians(mean_anom)
    centre = (
        math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t))
        + math.sin(2 * m) * (0.019993 - 0.000101 * t)
        + math.sin(3 * m) * 0.000289
    )
    true_long = mean_long + centre

    # Apparent longitude, corrected for nutation and aberration.
    omega = 125.04 - 1934.136 * t
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))

    # Obliquity of the ecliptic, with the same nutation correction.
    seconds = 21.448 - t * (46.8150 + t * (0.00059 - t * 0.001813))
    oblique = 23.0 + (26.0 + seconds / 60.0) / 60.0
    oblique_corr = oblique + 0.00256 * math.cos(math.radians(omega))

    # Right ascension is not needed; go straight to declination and hour angle.
    decl = math.degrees(
        math.asin(
            math.sin(math.radians(oblique_corr)) * math.sin(math.radians(app_long))
        )
    )

    # Equation of time, in minutes.
    var_y = math.tan(math.radians(oblique_corr / 2.0)) ** 2
    eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    ml = math.radians(mean_long)
    eq_time = 4.0 * math.degrees(
        var_y * math.sin(2 * ml)
        - 2.0 * eccent * math.sin(m)
        + 4.0 * eccent * var_y * math.sin(m) * math.cos(2 * ml)
        - 0.5 * var_y * var_y * math.sin(4 * ml)
        - 1.25 * eccent * eccent * math.sin(2 * m)
    )

    utc = dt.astimezone(timezone.utc)
    minutes_utc = utc.hour * 60.0 + utc.minute + utc.second / 60.0
    true_solar_time = (minutes_utc + eq_time + 4.0 * lon_deg) % 1440.0

    hour_angle = true_solar_time / 4.0 - 180.0
    if hour_angle < -180.0:
        hour_angle += 360.0

    lat = math.radians(lat_deg)
    dec = math.radians(decl)
    ha = math.radians(hour_angle)

    cos_zenith = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(ha)
    cos_zenith = max(-1.0, min(1.0, cos_zenith))
    zenith = math.degrees(math.acos(cos_zenith))
    altitude = 90.0 - zenith

    # Azimuth, clockwise from north.
    denom = math.cos(lat) * math.sin(math.radians(zenith))
    if abs(denom) < 1e-9:
        azimuth = 180.0 if lat_deg > decl else 0.0
    else:
        cos_az = (math.sin(lat) * cos_zenith - math.sin(dec)) / denom
        cos_az = max(-1.0, min(1.0, cos_az))
        azimuth = math.degrees(math.acos(cos_az))
        azimuth = (180.0 + azimuth) % 360.0 if hour_angle > 0 else (180.0 - azimuth) % 360.0

    return altitude, azimuth


def demo() -> None:
    """Self-check against astronomical invariants, not recalled tables.

    Every assertion here is derivable from first principles, so the check
    cannot be quietly satisfied by a wrong constant that happens to match a
    number someone half-remembered.
    """
    from zoneinfo import ZoneInfo

    nyc = ZoneInfo("America/New_York")
    LAT, LON = 40.7128, -74.0060  # the Battery

    def altitude_at(dt):
        return solar_position(dt, LAT, LON)[0]

    # 1. Solar noon lands where longitude says it should. NYC sits 14.006 deg
    #    west of the 60 W daylight-time meridian, which is 56.0 minutes of
    #    rotation, so local solar noon is around 12:56 plus the equation of
    #    time. Find the true maximum by scanning and check it is in that hour.
    day = datetime(2026, 7, 21, tzinfo=nyc)
    best = max(
        (day.replace(hour=12) + timedelta(minutes=i) for i in range(0, 120)),
        key=altitude_at,
    )
    assert 12 <= best.hour <= 13, f"solar noon at {best:%H:%M}, expected near 13:00"

    # 2. At solar noon the sun is due south to within a degree, by definition.
    _, az_noon = solar_position(best, LAT, LON)
    assert abs(az_noon - 180.0) < 1.0, f"azimuth at solar noon is {az_noon:.1f}"

    # 3. Noon altitude equals 90 - latitude + declination. Declination is
    #    computed here independently, by the standard cosine approximation,
    #    so this cross-checks the full Meeus path against a one-line formula.
    doy = day.timetuple().tm_yday
    decl_approx = -23.44 * math.cos(math.radians(360.0 / 365.0 * (doy + 10)))
    expected = 90.0 - LAT + decl_approx
    assert abs(altitude_at(best) - expected) < 1.0, (
        f"noon altitude {altitude_at(best):.2f}, cosine approximation gives {expected:.2f}"
    )

    # 4. The solstices bracket the year, and the summer sun is higher.
    summer = max(
        (datetime(2026, 6, 21, 12, tzinfo=nyc) + timedelta(minutes=i) for i in range(0, 120)),
        key=altitude_at,
    )
    winter = max(
        (datetime(2026, 12, 21, 11, tzinfo=nyc) + timedelta(minutes=i) for i in range(0, 120)),
        key=altitude_at,
    )
    spread = altitude_at(summer) - altitude_at(winter)
    assert abs(spread - 2 * 23.44) < 1.0, f"solstice spread {spread:.2f}, expected 46.88"

    # 5. The sun rises in the east and sets in the west, on any day.
    _, az_morning = solar_position(day.replace(hour=8), LAT, LON)
    _, az_evening = solar_position(day.replace(hour=18), LAT, LON)
    assert 45 < az_morning < 135, f"08:00 azimuth {az_morning:.1f} is not easterly"
    assert 225 < az_evening < 315, f"18:00 azimuth {az_evening:.1f} is not westerly"

    # 6. Below the horizon at midnight.
    assert altitude_at(day.replace(hour=0, minute=30)) < 0

    # 7. The demo hour the thermal grid uses must actually be sunlit, or the
    #    whole shadow pass is meaningless.
    alt_demo, az_demo = solar_position(datetime(2026, 7, 21, 15, tzinfo=nyc), LAT, LON)
    assert alt_demo > 30, f"15:00 July altitude {alt_demo:.1f} is too low for a peak-MRT hour"
    assert 225 < az_demo < 290, f"15:00 July azimuth {az_demo:.1f} should be west-southwest"

    print(
        f"solar.py self-check passed "
        f"(21 Jul 15:00 EDT: altitude {alt_demo:.1f} deg, azimuth {az_demo:.1f} deg)"
    )


if __name__ == "__main__":
    demo()
