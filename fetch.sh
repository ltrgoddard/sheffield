#!/usr/bin/env bash
# refresh the data feeds. each fetcher is independent — one failing never aborts
# the rest. safe to run on a cron or loop.
#   ./fetch.sh         transit (routes) + all live feeds
#   ./fetch.sh live    just the fast-moving feeds (crime, council, vehicles)
# lidar is a one-off pipeline over downloaded geotiffs — see fetchers/lidar.py.
set -uo pipefail
cd "$(dirname "$0")/fetchers"
[ "${1:-}" = live ] && jobs="crime council vehicles" || jobs="transit crime council vehicles"
for f in $jobs; do echo "▸ $f"; python3 "$f.py" || echo "  ! $f failed"; done
