# Weather Map

An interactive live weather map and 3D globe in the style of [zoom.earth](https://zoom.earth/), built with **Python + Flask**, **Leaflet** and **MapLibre GL**.

**Live demo:** https://3dworldfreenow.github.io/weather/ (after GitHub Pages is enabled; see [Host the demo on GitHub Pages](#host-the-demo-on-github-pages))

## Features

- 🌐 **3D globe:** the site opens on a spinning round Earth (MapLibre GL) with the live satellite imagery, day/night shading and labels. Click anywhere to open the detailed map and forecast for that place
- 🌍 **Live Earth:** near-real-time imagery from five geostationary weather satellites (GOES-West, GOES-East, Meteosat 0°, Meteosat IODC, Himawari), each clipped to its own longitude band and stitched into one global layer, updated every 10 minutes
  - *True colour*: each satellite's GeoColor product where the provider publishes one (real colour by day, infrared at night), infrared elsewhere
  - *Infrared clouds*: clouds day and night, blended over the base map
  - Live day/night shading from the sun's position, and a **Sources** panel listing every satellite, product, image time and provider
- 🌊 **El Niño:** daily sea surface temperature anomaly map, the four official Niño regions with their latest weekly anomaly, 12-week trend and 4-week change, current phase (El Niño / La Niña / neutral), the Oceanic Niño Index, and a highlight on the region where warming is strongest
- 🛰️ **Base imagery:** high-res Esri imagery, NASA VIIRS/MODIS daily true colour with a date picker, or a dark map
- 🌧️ **Rain radar:** about 2 hours of animated radar frames (RainViewer)
- 💨 **Wind:** animated wind particles over a wind-speed heat map
- 🌡️ **Temperature, ☔ precipitation, 💧 humidity, ☁️ clouds, 🧭 pressure:** smooth forecast overlays for the next 48 hours
- ⏯️ **Timeline:** play/pause and scrub through radar frames or forecast hours (keyboard: space, ←, →)
- 🌀 **Events:** active tropical storms (with tracks), wildfires and volcanoes from NASA EONET
- 📍 **Click anywhere** (or search a place, or use your location) for current conditions, the next 24 hours and a 7-day forecast
- °C/°F toggle, shareable URLs (`/#28.61,77.21,6z/wind`), and a mobile-friendly layout

All data sources are free and need **no API keys**:

| Data | Provider |
| --- | --- |
| Forecasts, grids, place search | [Open-Meteo](https://open-meteo.com/) |
| Radar | [RainViewer](https://www.rainviewer.com/api.html) |
| Storms / fires / volcanoes | [NASA EONET](https://eonet.gsfc.nasa.gov/) |
| Live satellites | GOES & Himawari via [NASA GIBS](https://earthdata.nasa.gov/gibs), Meteosat via [EUMETView](https://view.eumetsat.int/) |
| El Niño indices | [NOAA CPC weekly Niño SSTs](https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for), [Oceanic Niño Index](https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt) |
| Sea surface temperature anomaly map | [GHRSST MUR](https://podaac.jpl.nasa.gov/MEaSUREs-MUR) via NASA GIBS |
| Base imagery, labels, dark map | Esri, NASA GIBS |

> Open-Meteo's free API is for non-commercial use. Check each provider's terms before running this commercially.

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py                    # http://127.0.0.1:5000
```

Production example:

```bash
gunicorn -w 2 -b 0.0.0.0:8000 app:app
```

## Host the demo on GitHub Pages

GitHub Pages only serves static files, so the demo is a static build of the same app:

- forecasts, forecast maps, place search and radar are fetched by the visitor's browser straight from Open-Meteo and RainViewer (`static/js/static-api.js`)
- data browsers cannot fetch themselves (NOAA El Niño files, satellite catalogues, events) is built by the Python code into `data/*.json`

The workflow `.github/workflows/pages.yml` runs the tests, builds the site with `scripts/build_static.py` and publishes it. It runs on every push and every 30 minutes, to keep the data fresh.

One-time setup:

1. GitHub Pages on a free account needs a **public** repository: *Settings → General → Danger Zone → Change visibility*. Private repositories need GitHub Pro, Team or Enterprise.
2. *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
3. Re-run the workflow (*Actions → Deploy demo to GitHub Pages → Run workflow*), or push a commit.

The site appears at `https://<user>.github.io/<repo>/`. Only the repository's default branch is deployed.

Build the static site locally:

```bash
python scripts/build_static.py dist
python -m http.server -d dist 8000   # http://localhost:8000
```

Run the tests:

```bash
pytest
```

## Project layout

```
app.py                     # entry point (dev server / gunicorn target)
weather_app/
  __init__.py              # Flask app factory
  routes.py                # page + JSON API
  services.py              # upstream API clients, caching, grid building
  satellites.py            # live satellite layer discovery and stitching
  enso.py                  # El Niño / La Niña status from NOAA CPC data
  templates/index.html     # page markup
  static/css/style.css     # UI styles
  static/js/app.js         # map, globe, layers, timeline, wind particles, panels
  static/js/static-api.js  # browser-only API used by the GitHub Pages demo
scripts/build_static.py    # builds the static demo into dist/
.github/workflows/pages.yml  # tests, builds and deploys the demo
tests/                     # API tests (upstream calls are mocked)
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/weather?lat=&lon=` | Current conditions, 24-hour and 7-day forecast |
| `GET /api/search?q=` | Place search |
| `GET /api/grid?layer=&south=&west=&north=&east=` | 48-hour forecast grid for the map view. `layer` is one of `temperature`, `wind`, `precipitation`, `clouds`, `humidity`, `pressure` |
| `GET /api/radar` | Available radar frames |
| `GET /api/satellites?style=truecolor\|infrared` | Live satellite layers, each with its longitude band, product and image time |
| `GET /api/enso` | El Niño status, Niño region anomalies and the SST anomaly map layer |
| `GET /api/events` | Active storms, wildfires and volcanoes |
| `GET /healthz` | Health check |

Satellite layer names are read from the NASA GIBS and EUMETView capability documents at run time, so changes on their side are picked up automatically. If a provider can't be reached, well-known layer names are used instead.

The forecast grid is snapped to a coarse lattice and fetched once for all overlay layers, so panning and switching layers reuse cached data. Open-Meteo's free tier counts every grid point as one call. If the limit is reached, the site shows a "wait a minute" message.

Responses are cached in memory, from 2 minutes (radar) to 1 hour (search), to stay well within the providers' rate limits.
