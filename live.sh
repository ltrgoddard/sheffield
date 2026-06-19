#!/usr/bin/env bash
# keep the fast feeds refreshing so live buses keep moving on the map.
# needs BODS_API_KEY in the environment for vehicle positions.
#   export BODS_API_KEY=…  &&  ./live.sh [seconds]
cd "$(dirname "$0")"
while :; do ./fetch.sh live >/dev/null 2>&1; sleep "${1:-15}"; done
