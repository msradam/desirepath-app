"""Build the thermal layer.

    uv run python -m pipeline.thermal build
    uv run python -m pipeline.thermal build --nta BK1602
    uv run python -m pipeline.thermal attach

`build` produces one proxy MRT grid per neighbourhood under data/thermal/.
`attach` joins those grids onto data/nyc-pedestrian.bin and writes the OSWB v3
file the router loads. `build` implies `attach` unless you pass --no-attach.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import click

from pipeline.thermal import attach as A
from pipeline.thermal import build as B

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"

# Heat-burdened neighbourhoods, NYC Heat Vulnerability Index 4 to 5.
# Brownsville is the demo case; the rest are here so the layer is not a single
# hand-tuned example.
NEIGHBOURHOODS = {
    "BK1602": "Brownsville, Brooklyn",
    "BX0101": "Mott Haven and Port Morris, Bronx",
    "BX0602": "Tremont, Bronx",
    "MN1102": "East Harlem North, Manhattan",
    "QN0303": "North Corona, Queens",
}

# The demo hour. NYC street-level MRT peaks in the mid afternoon, a couple of
# hours after solar noon, because the surfaces are still releasing stored heat.
DEMO_WHEN = datetime(2026, 7, 21, 15, 0, tzinfo=B.NYC)


@click.group()
def cli() -> None:
    """Thermal layer for the ariadne pedestrian router."""


@cli.command()
@click.option("--nta", "ntas", multiple=True, help="NTA 2020 code. Repeatable. Defaults to all five.")
@click.option("--when", default=None, help="ISO local datetime. Defaults to 2026-07-21T15:00.")
@click.option("--attach/--no-attach", default=True, show_default=True)
def build(ntas: tuple[str, ...], when: str | None, attach: bool) -> None:
    """Fetch sources, compute proxy MRT grids, and join them onto the graph."""
    targets = list(ntas) or list(NEIGHBOURHOODS)
    moment = datetime.fromisoformat(when).replace(tzinfo=B.NYC) if when else DEMO_WHEN

    for nta in targets:
        label = NEIGHBOURHOODS.get(nta, nta)
        click.echo(f"  {nta}  {label}")
        tg, meta = B.build_neighbourhood(DATA, nta, moment)
        path = B.save(DATA, tg, meta)
        stats = meta["mrt_c"]
        click.echo(
            f"      {meta['rows']}x{meta['cols']} cells at {meta['cell_m']:.0f} m, "
            f"{meta['buildings']:,} buildings, {meta['trees_used']:,} trees"
        )
        click.echo(
            f"      MRT {stats['min']:.1f} to {stats['max']:.1f} C, "
            f"median {stats['median']:.1f} C, "
            f"{stats['shaded_share'] * 100:.0f}% below 45 C  ->  {path.name}"
        )

    if attach:
        _attach(targets)


@cli.command(name="attach")
@click.option("--nta", "ntas", multiple=True)
def attach_cmd(ntas: tuple[str, ...]) -> None:
    """Join existing grids onto the pedestrian binary."""
    _attach(list(ntas) or list(NEIGHBOURHOODS))


def _attach(targets: list[str]) -> None:
    src = DATA / "nyc-pedestrian.bin"
    dst = DATA / "nyc-pedestrian-thermal.bin"
    click.echo(f"\n  attaching {len(targets)} grid(s) to {src.name}")

    nodes, edges, _raw, version = A.read_v2(src)
    lon, lat = A.edge_midpoints(nodes, edges)
    mrt, per_nta = A.sample_grids(DATA, targets, lon, lat)
    report = A.write_v3(src, dst, mrt)
    report["per_nta_edges"] = per_nta
    report["neighbourhoods"] = {n: NEIGHBOURHOODS.get(n, n) for n in targets}
    report["tier"] = "proxy"

    (DATA / "thermal" / "attach-report.json").write_text(json.dumps(report, indent=2) + "\n")

    for nta, n in per_nta.items():
        click.echo(f"      {nta}  {n:,} edges")
    click.echo(
        f"      {report['edges_with_mrt']:,} of {report['edges']:,} edges carry MRT "
        f"({report['coverage_share'] * 100:.2f}%)"
    )
    click.echo(
        f"      MRT {report['mrt_c']['min']:.1f} to {report['mrt_c']['max']:.1f} C, "
        f"median {report['mrt_c']['median']:.1f} C"
    )
    click.echo(f"      wrote {dst.name}, {report['bytes'] / 1e6:.1f} MB (OSWB v3)")


@cli.command()
def summary() -> None:
    """Print what has been built, for the handoff numbers."""
    for nta in NEIGHBOURHOODS:
        path = DATA / "thermal" / f"{nta}.json"
        if not path.exists():
            click.echo(f"  {nta}  not built")
            continue
        meta = json.loads(path.read_text())
        s = meta["mrt_c"]
        click.echo(
            f"  {nta}  {meta['name']:<22} "
            f"MRT {s['min']:.1f}-{s['max']:.1f} C  median {s['median']:.1f} C  "
            f"{meta['trees_used']:,} trees  tier={meta['tier']}"
        )


if __name__ == "__main__":
    cli()
