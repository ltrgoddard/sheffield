# sheffield — data orchestration. the one entry point for fetching every open-data
# feed, streaming lidar, and serving the model. python runs under `uv`; the news llm
# key loads from .env (copy .env.example). feeds are independent and run in parallel —
# one failing never aborts the rest, and writes are atomic. (live buses need no fetcher:
# the frontend pulls them straight from bustimes.org, a cors-enabled no-key feed.)
#   make           fetch every feed, then the freshness manifest
#   make lidar     stream ea lidar → data/terrain (needs gdal)
#   make serve     static server on :$(PORT)
-include .env
export                                   # hand .env (ANTHROPIC_API_KEY) to the fetchers
MAKEFLAGS += -j 8                        # feeds are independent; fetch them concurrently
PY    := uv run --quiet python
PORT  ?= 8000
FEEDS := transit bus_stops buildings roads crime council rivers trees planning news reddit tribune air

.PHONY: all data $(FEEDS) manifest lidar serve clean
all: data
data: manifest
manifest: $(FEEDS)
	@$(PY) fetchers/manifest.py
$(FEEDS):
	@$(PY) fetchers/$@.py 2>&1 | sed 's/^/[$@] /'
lidar:
	@$(PY) fetchers/lidar.py
serve:
	@echo "sheffield model → http://localhost:$(PORT)"; $(PY) -m http.server $(PORT)
clean:
	@rm -f data/manifest.json
