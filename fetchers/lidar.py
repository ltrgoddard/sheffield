#!/usr/bin/env python3
"""fuse environment agency lidar into the map as real ground relief.

the national lidar programme (the dataset linked in the brief) publishes 1 m
dsm/dtm geotiffs. download the tiles covering sheffield from the ea portal, then
point this script at them:

    python3 fetchers/lidar.py ~/Downloads/lidar/*.tif

it mosaics them, reprojects to web mercator, terrarium-encodes the elevation
into rgb and slices xyz png tiles into data/terrain/. the frontend auto-detects
that folder and renders it as 3d terrain (falling back to the global aws dem
otherwise), so sheffield's real hills sit beneath the osm buildings.

requires the gdal command-line tools (gdalbuildvrt, gdalwarp, gdal_calc.py,
gdal2tiles.py) — `brew install gdal`.
"""
import sys, subprocess, tempfile, pathlib, shutil

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"
ZOOM = "11-15"


def run(*cmd):
    print("·", cmd[0], *(str(c) for c in cmd[1:][:3]), "…", file=sys.stderr)
    subprocess.run([str(c) for c in cmd], check=True)


def main(tifs):
    for t in ("gdalbuildvrt", "gdalwarp", "gdal_calc.py", "gdal2tiles.py"):
        if not shutil.which(t):
            sys.exit(f"missing {t} — install gdal (brew install gdal)")
    tmp = pathlib.Path(tempfile.mkdtemp())
    vrt, merc = tmp / "src.vrt", tmp / "merc.tif"
    run("gdalbuildvrt", vrt, *tifs)
    # reproject to web mercator, single bilinear-resampled float band
    run("gdalwarp", "-t_srs", "EPSG:3857", "-r", "bilinear", "-dstnodata", "0",
        "-co", "TILED=YES", vrt, merc)
    # terrarium encode: (R*256 + G + B/256) - 32768 == metres
    bands = {}
    for ch, calc in (("R", "floor((A+32768)/256)"),
                     ("G", "numpy.mod(numpy.floor(A+32768),256)"),
                     ("B", "floor((A+32768-numpy.floor(A+32768))*256)")):
        bands[ch] = tmp / f"{ch}.tif"
        run("gdal_calc.py", "-A", merc, f"--outfile={bands[ch]}", f"--calc={calc}",
            "--type=Byte", "--quiet")
    rgb = tmp / "terrarium.vrt"
    run("gdalbuildvrt", "-separate", rgb, bands["R"], bands["G"], bands["B"])
    out = DATA / "terrain"
    shutil.rmtree(out, ignore_errors=True)
    run("gdal2tiles.py", "--xyz", "-p", "mercator", "-z", ZOOM, "-w", "none",
        "--processes", "4", rgb, out)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"terrain tiles written to {out}", file=sys.stderr)


if __name__ == "__main__":
    files = [a for a in sys.argv[1:] if a.lower().endswith((".tif", ".tiff", ".asc"))]
    if not files:
        sys.exit(__doc__)
    main(files)
