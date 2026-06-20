#!/usr/bin/env python3
"""fuse environment agency lidar into the map as real ground relief.

by default this needs no arguments and no manual downloads: it streams the EA
LIDAR Composite DTM (1 m, the dataset in the brief) straight from the agency's
open WCS over the sheffield bounding box, mosaics it, reprojects to web mercator,
terrarium-encodes the elevation and slices xyz tiles into data/terrain/. the
frontend auto-detects that folder and renders sheffield's real hills beneath the
osm buildings.

    make lidar                                # stream ea lidar for sheffield
    uv run python fetchers/lidar.py ~/dsm/*.tif   # or process geotiffs you supply

requires gdal (`brew install gdal`); the gdal cli tools are shelled out to.
"""
import sys, subprocess, tempfile, pathlib, shutil
from common import fetch, log

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"
WCS = "https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs"
CID = "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m"
# sheffield's full administrative boundary, british national grid (epsg:27700) metres: ~32 km × 23 km
E0, E1, N0, N1 = 413000, 445000, 378000, 401000
BLOCK, RES = 5000, 5  # fetch 5 km blocks at 5 m — plenty for web terrain
ZOOM = "10-14"


def run(*cmd):
    subprocess.run([str(c) for c in cmd], check=True)


def stream_lidar(into):
    """pull the sheffield dtm from the ea wcs in blocks; return the geotiffs."""
    tifs = []
    for e in range(E0, E1, BLOCK):
        for n in range(N0, N1, BLOCK):
            p = into / f"dtm_{e}_{n}.tif"
            try:
                # two subset params (E and N) won't fit urlencode's dict — build the url by hand
                data = fetch(f"{WCS}?service=WCS&version=2.0.1&request=GetCoverage"
                             f"&coverageId={CID}&format=image/tiff&scalefactor={1/RES}"
                             f"&subset=E({e},{e+BLOCK})&subset=N({n},{n+BLOCK})", timeout=120)
            except Exception as ex:
                log(f"  block {e},{n} skipped ({ex})"); continue
            if data[:2] in (b"II", b"MM"):  # valid tiff magic
                p.write_bytes(data); tifs.append(p)
                log(f"  block {e},{n}  {len(data)//1024} kb")
    return tifs


def tile(tifs):
    for t in ("gdalbuildvrt", "gdalwarp", "gdal_calc.py", "gdal2tiles.py"):
        if not shutil.which(t):
            sys.exit(f"missing {t} — install gdal")
    tmp = pathlib.Path(tempfile.mkdtemp())
    vrt, merc = tmp / "src.vrt", tmp / "merc.tif"
    run("gdalbuildvrt", "-q", vrt, *tifs)
    run("gdalwarp", "-q", "-t_srs", "EPSG:3857", "-r", "bilinear", "-dstnodata", "0", vrt, merc)
    bands = {}
    for ch, calc in (("R", "floor((A+32768)/256)"),
                     ("G", "numpy.mod(numpy.floor(A+32768),256)"),
                     ("B", "floor((A+32768-numpy.floor(A+32768))*256)")):
        bands[ch] = tmp / f"{ch}.tif"
        run("gdal_calc.py", "-A", merc, f"--outfile={bands[ch]}", f"--calc={calc}", "--type=Byte", "--quiet")
    rgb = tmp / "terrarium.vrt"
    run("gdalbuildvrt", "-q", "-separate", rgb, bands["R"], bands["G"], bands["B"])
    out = DATA / "terrain"; shutil.rmtree(out, ignore_errors=True)
    run("gdal2tiles.py", "--xyz", "-p", "mercator", "-z", ZOOM, "-w", "none", "--processes", "4", "-q", rgb, out)
    shutil.rmtree(tmp, ignore_errors=True)
    log(f"terrain tiles → {out}")


if __name__ == "__main__":
    supplied = [a for a in sys.argv[1:] if a.lower().endswith((".tif", ".tiff", ".asc"))]
    if supplied:
        tile(supplied)
    else:
        tmp = pathlib.Path(tempfile.mkdtemp())
        log("lidar: streaming ea lidar composite dtm for sheffield…")
        tifs = stream_lidar(tmp)
        if not tifs:
            sys.exit("no lidar returned from the ea wcs")
        log(f"lidar: {len(tifs)} blocks; building terrain tiles…")
        tile(tifs)
        shutil.rmtree(tmp, ignore_errors=True)
