#!/usr/bin/env bash
# serve the model locally. the frontend reads data/*.geojson from this same
# origin, so a plain static server is all that's needed.
cd "$(dirname "$0")"
port="${1:-8000}"
echo "sheffield model → http://localhost:$port"
exec python3 -m http.server "$port"
