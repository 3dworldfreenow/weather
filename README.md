# Weather Map

An interactive live weather map in the style of [zoom.earth](https://zoom.earth/), built with **Python + Flask** and **Leaflet**.

## Features

- 🛰️ **Satellite:** high-res Esri imagery, or NASA VIIRS/MODIS daily true-colour imagery with a date picker
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
| Satellite imagery | [NASA GIBS](https://earthdata.nasa.gov/gibs), Esri World Imagery |
| Labels / dark map | CARTO, OpenStreetMap |

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
  templates/index.html     # page markup
  static/css/style.css     # UI styles
  static/js/app.js         # map, layers, timeline, wind particles, forecast panel
tests/test_app.py          # API tests (upstream calls are mocked)
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/weather?lat=&lon=` | Current conditions, 24-hour and 7-day forecast |
| `GET /api/search?q=` | Place search |
| `GET /api/grid?layer=&south=&west=&north=&east=` | 48-hour forecast grid for the map view. `layer` is one of `temperature`, `wind`, `precipitation`, `clouds`, `humidity`, `pressure` |
| `GET /api/radar` | Available radar frames |
| `GET /api/events` | Active storms, wildfires and volcanoes |
| `GET /healthz` | Health check |

Responses are cached in memory, from 2 minutes (radar) to 1 hour (search), to stay well within the providers' rate limits.
