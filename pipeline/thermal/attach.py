"""Join thermal grids onto the pedestrian graph: OSWB v2 in, OSWB v3 out.

The join is spatial, at each edge's midpoint, which is why it needs no edge
identity and works against any OSWB file regardless of which pipeline built it.
It is also why swapping in a SOLWEIG raster changes nothing here.

Edges outside every surveyed neighbourhood keep `mrt = 0`, the not-surveyed
sentinel, so the router treats them as carrying no thermal information rather
than as being cool.
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

from pipeline.thermal import build as B
from pipeline.thermal import grid as G

MAGIC = b"OSWB"
HEADER = struct.Struct("<4sB3xII")
NODE = struct.Struct("<ffBx")
EDGE_V2 = struct.Struct("<IIfhBBBB")
EDGE_V3 = struct.Struct("<IIfhBBBBB")


def read_v2(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Return (node lon/lat array, node attr bytes, edge record array, version).

    The edge array is kept as a structured numpy view over the raw bytes so a
    1.37 million edge file round-trips without a Python loop.
    """
    raw = path.read_bytes()
    magic, version, n_nodes, n_edges = HEADER.unpack_from(raw, 0)
    if magic != MAGIC:
        raise SystemExit(f"{path} is not an OSWB file")
    if version not in (2, 3):
        raise SystemExit(f"{path} is OSWB v{version}; this tool handles v2 and v3")

    off = HEADER.size
    node_dtype = np.dtype([("lon", "<f4"), ("lat", "<f4"), ("attrs", "u1"), ("pad", "u1")])
    nodes = np.frombuffer(raw, dtype=node_dtype, count=n_nodes, offset=off)
    off += node_dtype.itemsize * n_nodes

    fields = [
        ("u", "<u4"), ("v", "<u4"), ("length", "<f4"), ("incline", "<i2"),
        ("footway", "u1"), ("surface", "u1"), ("flags", "u1"), ("width", "u1"),
    ]
    if version == 3:
        fields.append(("mrt", "u1"))
    edge_dtype = np.dtype(fields)
    edges = np.frombuffer(raw, dtype=edge_dtype, count=n_edges, offset=off)
    return nodes, edges, raw, version


def edge_midpoints(nodes: np.ndarray, edges: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Midpoint of every edge, in WGS84.

    OSWB edge geometry is the straight line between its endpoints, so the
    midpoint is exact rather than an approximation of a polyline.
    """
    lon = (nodes["lon"][edges["u"]] + nodes["lon"][edges["v"]]) / 2.0
    lat = (nodes["lat"][edges["u"]] + nodes["lat"][edges["v"]]) / 2.0
    return lon.astype(np.float64), lat.astype(np.float64)


def sample_grids(root: Path, ntas: list[str], lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, dict]:
    """Sample every neighbourhood grid, taking the first that covers a point.

    Grids may overlap at their margins. Where two disagree the first wins,
    deterministically by the order `ntas` is given, so a rebuild is stable.
    """
    x, y = B.project(lon, lat)
    out = np.full(lon.shape, np.nan, dtype=np.float32)
    per_nta: dict[str, int] = {}

    for nta in ntas:
        tg, _meta = B.load(root, nta)
        sampled = tg.sample(x, y)
        take = np.isnan(out) & np.isfinite(sampled)
        out[take] = sampled[take]
        per_nta[nta] = int(take.sum())

    return out, per_nta


def write_v3(src: Path, dst: Path, mrt_c: np.ndarray) -> dict:
    """Rewrite the binary at v3 with the supplied per-edge temperatures."""
    nodes, edges, raw, version = read_v2(src)
    if mrt_c.shape[0] != edges.shape[0]:
        raise SystemExit(f"{mrt_c.shape[0]} temperatures for {edges.shape[0]} edges")

    mrt_byte = G.encode_mrt(mrt_c)

    new_dtype = np.dtype([
        ("u", "<u4"), ("v", "<u4"), ("length", "<f4"), ("incline", "<i2"),
        ("footway", "u1"), ("surface", "u1"), ("flags", "u1"), ("width", "u1"),
        ("mrt", "u1"),
    ])
    out = np.zeros(edges.shape[0], dtype=new_dtype)
    for name in ("u", "v", "length", "incline", "footway", "surface", "flags", "width"):
        out[name] = edges[name]
    out["mrt"] = mrt_byte

    node_bytes_off = HEADER.size
    node_dtype_size = 10
    node_block = raw[node_bytes_off : node_bytes_off + node_dtype_size * nodes.shape[0]]

    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(dst, "wb") as f:
        f.write(HEADER.pack(MAGIC, 3, nodes.shape[0], edges.shape[0]))
        f.write(node_block)
        f.write(out.tobytes())

    surveyed = int((mrt_byte != 0).sum())
    finite = mrt_c[np.isfinite(mrt_c)]
    return {
        "source_version": version,
        "nodes": int(nodes.shape[0]),
        "edges": int(edges.shape[0]),
        "edges_with_mrt": surveyed,
        "coverage_share": round(surveyed / max(1, edges.shape[0]), 5),
        "mrt_c": {
            "min": float(finite.min()) if finite.size else None,
            "median": float(np.median(finite)) if finite.size else None,
            "max": float(finite.max()) if finite.size else None,
        },
        "bytes": dst.stat().st_size,
    }


def demo() -> None:
    """Self-check the binary round trip on a synthetic two-node graph."""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "v2.bin"
        with open(src, "wb") as f:
            f.write(HEADER.pack(MAGIC, 2, 2, 1))
            f.write(NODE.pack(-73.91, 40.66, 0))
            f.write(NODE.pack(-73.909, 40.661, 0))
            f.write(EDGE_V2.pack(0, 1, 100.0, 0, 0, 1, 0, 0))

        nodes, edges, _raw, version = read_v2(src)
        assert version == 2 and edges.shape[0] == 1
        assert "mrt" not in edges.dtype.names

        lon, lat = edge_midpoints(nodes, edges)
        assert abs(lon[0] - -73.9095) < 1e-4, lon[0]
        assert abs(lat[0] - 40.6605) < 1e-4, lat[0]

        dst = Path(td) / "v3.bin"
        report = write_v3(src, dst, np.array([47.5], dtype=np.float32))
        assert report["edges_with_mrt"] == 1
        assert report["bytes"] == HEADER.size + 10 * 2 + 19 * 1, report["bytes"]

        # Read it back at v3 and confirm the temperature survived.
        nodes2, edges2, _raw2, v2 = read_v2(dst)
        assert v2 == 3
        assert abs(G.decode_mrt(edges2["mrt"])[0] - 47.5) <= 0.25
        # Everything else must be byte-identical.
        for name in ("u", "v", "length", "incline", "footway", "surface", "flags", "width"):
            assert edges2[name][0] == edges[name][0], name
        assert nodes2["lon"][0] == nodes["lon"][0]

        # An unsurveyed edge stays unsurveyed.
        dst2 = Path(td) / "v3-gap.bin"
        write_v3(src, dst2, np.array([np.nan], dtype=np.float32))
        _n, e3, _r, _v = read_v2(dst2)
        assert e3["mrt"][0] == 0, "NaN must land on the not-surveyed sentinel"

    print("attach.py self-check passed")


if __name__ == "__main__":
    demo()
