# sheffield — data orchestration. the one entry point for fetching every open-data
# feed, streaming lidar, and serving the model. python runs under `uv`; live-feed
# secrets load from .env (copy .env.example). feeds are independent and run in
# parallel — one failing never aborts the rest, and writes are atomic.
#   make           fetch every feed, then the freshness manifest
#   make live      just the fast feeds (live buses)
#   make watch     loop the live feeds every $(EVERY)s so buses keep moving
#   make lidar     stream ea lidar → data/terrain (needs gdal)
#   make serve     static server on :$(PORT)
-include .env
export                                   # hand .env (BODS_API_KEY, …) to the fetchers
MAKEFLAGS += -j 8                        # feeds are independent; fetch them concurrently
PY    := uv run --quiet python
PORT  ?= 8000
EVERY ?= 15
FEEDS := transit buildings roads crime council rivers trees planning news air vehicles

.PHONY: all data $(FEEDS) manifest live watch lidar serve clean
all: data
data: manifest
manifest: $(FEEDS)
	@$(PY) fetchers/manifest.py
$(FEEDS):
	@$(PY) fetchers/$@.py 2>&1 | sed 's/^/[$@] /'
live:
	@$(PY) fetchers/vehicles.py
watch:
	@while :; do $(MAKE) -s live >/dev/null 2>&1; sleep $(EVERY); done
lidar:
	@$(PY) fetchers/lidar.py
serve:
	@echo "sheffield model → http://localhost:$(PORT)"; $(PY) -m http.server $(PORT)
clean:
	@rm -f data/manifest.json
