"""Convert world-atlas countries-110m TopoJSON (Natural Earth, public domain) to compact GeoJSON.

Usage: python scripts/make_countries.py path/to/countries-110m.json
Writes weather_app/static/data/countries.geojson (committed).
"""

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "weather_app" / "static" / "data" / "countries.geojson"


def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append([round(x * sx + tx, 2), round(y * sy + ty, 2)])
        arcs.append(pts)
    return arcs


def ring(indices, arcs):
    pts = []
    for i in indices:
        arc = arcs[i] if i >= 0 else arcs[~i][::-1]
        pts.extend(arc if not pts else arc[1:])
    return pts


def main(src):
    topo = json.loads(Path(src).read_text())
    arcs = decode_arcs(topo)
    features = []
    for g in topo["objects"]["countries"]["geometries"]:
        if g["type"] == "Polygon":
            geom = {"type": "Polygon", "coordinates": [ring(r, arcs) for r in g["arcs"]]}
        elif g["type"] == "MultiPolygon":
            geom = {"type": "MultiPolygon", "coordinates": [[ring(r, arcs) for r in p] for p in g["arcs"]]}
        else:
            continue
        features.append({"type": "Feature", "id": g.get("id"),
                         "properties": {"id": g.get("id"), "name": g["properties"]["name"]}, "geometry": geom})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    print(f"{len(features)} countries -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1])
