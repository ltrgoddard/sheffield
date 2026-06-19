#!/usr/bin/env bash
# refresh the data feeds. every fetcher is independent and runs in parallel —
# one failing never aborts the rest, and writes are atomic so the frontend never
# reads a half-finished file. safe on a cron or loop.
#   ./fetch.sh         everything (network, civic layers, live feeds)
#   ./fetch.sh live    just the fast-moving feeds (buses, river levels)
# lidar is a one-off pipeline over downloaded geotiffs — see fetchers/lidar.py.
set -uo pipefail
cd "$(dirname "$0")/fetchers"
live="vehicles"
all="transit buildings crime council rivers trees planning news air $live"
jobs=$([ "${1:-}" = live ] && echo "$live" || echo "$all")
pids=""
for f in $jobs; do
  { python3 "$f.py" 2>&1 || echo "! $f failed"; } | sed "s/^/[$f] /" &
  pids="$pids $!"
done
wait $pids
python3 manifest.py   # freshness index for the frontend / ops
