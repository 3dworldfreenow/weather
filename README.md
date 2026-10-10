# El Niño Tracker

A live El Niño tracker on a 3D globe and map, in the style of [zoom.earth](https://zoom.earth/), built with **Python + Flask**, **Leaflet** and **MapLibre GL**.

**Live demo:** https://3dworldfreenow.github.io/weather/ (after GitHub Pages is enabled; see [Host the demo on GitHub Pages](#host-the-demo-on-github-pages))

## Features

- 🌊 **El Niño status:** current phase (El Niño / La Niña / neutral) and strength from the latest weekly Niño 3.4 anomaly, the 4-week trend, and NOAA's official Oceanic Niño Index
- 🎯 **Where it is building:** the four official Niño regions (1+2, 3, 3.4, 4), each with its latest anomaly, a 12-week trend line and its 4-week change; the warmest region is highlighted. Click a region to zoom to it
- 🌡️ **Sea temperature map:** daily sea surface temperature anomaly (how much warmer or colder than normal), switchable with the *Sea temp* button
- 🌐 **3D globe and flat map:** the site opens on a round Earth centred on the equatorial Pacific; switch to the flat map any time
- 🛰️ **Live Earth backdrop:** near-real-time imagery from five geostationary weather satellites (GOES-West, GOES-East, Meteosat 0°, Meteosat IODC, Himawari), stitched by longitude band, in true colour or infrared, plus live day/night shading
- 📰 **World news:** El Niño articles from around the world, in many languages, filterable by country and language, from GDELT and Google News editions (India in English and Hindi, US, UK, Australia, Philippines, Peru, Brazil, France, Indonesia, Japan)
- ▶️ **Videos:** the latest El Niño / ENSO videos from NOAA, NASA, WMO, the Met Office and Australia's Bureau of Meteorology (YouTube channel feeds), known explainers, and a one-click YouTube search; videos play inside the site
- 📘 **Learn:** plain-language answers to common questions (what El Niño and La Niña are, how they are measured, the Niño regions, effects on India's monsoon and the world)
- 📚 **Sources panel** listing every data source, satellite, product and image time

All data sources are free and need **no API keys**:

| Data | Provider |
| --- | --- |
| Niño region indices (weekly) | [NOAA CPC weekly Niño SSTs](https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for) |
| Oceanic Niño Index (official, 3-month) | [NOAA CPC ONI](https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt) |
| Sea surface temperature anomaly map | [GHRSST MUR](https://podaac.jpl.nasa.gov/MEaSUREs-MUR) via [NASA GIBS](https://earthdata.nasa.gov/gibs) |
| Live satellites | GOES & Himawari via NASA GIBS, Meteosat via [EUMETView](https://view.eumetsat.int/) |
| World news | [GDELT](https://www.gdeltproject.org/) DOC API, [Google News](https://news.google.com/) RSS |
| Videos | YouTube channel RSS feeds (no API key); YouTube search links out |
| Base imagery and labels | Esri, NASA GIBS |

The El Niño / La Niña label comes from the latest weekly Niño 3.4 reading. NOAA officially declares El Niño using the 3-month ONI together with atmospheric signs; see the [CPC ENSO discussion](https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml).

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

GitHub Pages only serves static files, so the demo is a static build of the same app. The data the browser needs (NOAA files, which browsers cannot fetch directly, the satellite catalogues and the news feed) is built by the Python code into `data/*.json`, which `static/js/static-api.js` reads.

The workflow `.github/workflows/pages.yml` runs the tests, builds the site with `scripts/build_static.py` and publishes it. It runs on every push and every 30 minutes, to keep the data fresh.

One-time setup:

1. GitHub Pages on a free account needs a **public** repository: *Settings → General → Danger Zone → Change visibility*. Private repositories need GitHub Pro, Team or Enterprise.
2. *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
3. Re-run the workflow (*Actions → Deploy demo to GitHub Pages → Run workflow*), or push a commit.

The site appears at `https://<user>.github.io/<repo>/`. Only the repository's default branch is deployed.

### Getting found in search engines

The site is built to be search-friendly:

- the page HTML already contains the current El Niño status, the Niño region readings, the latest headlines and the Learn answers, so search engines can read it without running JavaScript
- title, description, canonical URL, and share previews (Open Graph / X cards with `static/img/og-image.png`)
- structured data (JSON-LD): `WebSite`, `WebApplication`, `FAQPage` and `Dataset`
- `sitemap.xml`, `robots.txt`, a web app manifest and icons (regenerate the images with `python scripts/make_images.py`)

To get indexed quickly:

1. **Google Search Console** (https://search.google.com/search-console): add a *URL prefix* property for `https://<user>.github.io/<repo>/`, choose the *HTML tag* method and copy the `content` value. In the repository, add it under *Settings → Secrets and variables → Actions → Variables* as `GOOGLE_SITE_VERIFICATION`, re-run the workflow, then click *Verify*. Submit `sitemap.xml` under *Sitemaps* and use *URL inspection → Request indexing*.
2. **Bing Webmaster Tools** (https://www.bing.com/webmasters), which also feeds DuckDuckGo and Yahoo: do the same with the `msvalidate.01` code as `BING_SITE_VERIFICATION`, or import the site from Google Search Console.
3. Share the link: links from other sites and social posts help search engines discover it. The share preview image appears automatically.

Note: a project site lives under `/<repo>/`, and crawlers only read `robots.txt` at the domain root, so submit the sitemap in Search Console directly. For the best ranking, use a custom domain (*Settings → Pages → Custom domain*) and set `SITE_URL` to it.

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
  enso.py                  # El Niño / La Niña status from NOAA CPC data
  news.py                  # El Niño news (GDELT, Google News) and videos (YouTube feeds)
  seo.py                   # page text, FAQ, structured data, sitemap, robots, manifest
  satellites.py            # live satellite layer discovery and stitching
  services.py              # HTTP helper and in-memory cache
  templates/index.html     # page markup
  static/css/style.css     # UI styles
  static/js/app.js         # map, globe, El Niño panel and overlays, live satellites
  static/js/static-api.js  # browser-only API used by the GitHub Pages demo
scripts/build_static.py    # builds the static demo into dist/
scripts/make_images.py     # draws the share image and app icons
.github/workflows/pages.yml  # tests, builds and deploys the demo
tests/                     # tests (upstream calls are mocked)
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/enso` | El Niño status, Niño region anomalies and the SST anomaly map layer |
| `GET /api/satellites?style=truecolor\|infrared` | Live satellite layers, each with its longitude band, product and image time |
| `GET /api/news` | El Niño news articles and videos, with the status of each source |
| `GET /robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` | Search engine and app files |
| `GET /healthz` | Health check |

Satellite layer names are read from the NASA GIBS and EUMETView capability documents at run time, so changes on their side are picked up automatically. If a provider can't be reached, well-known layer names are used instead. Responses are cached in memory (El Niño data for 6 hours, news for 30 minutes). News links open the original publisher's site; YouTube's search API needs a key, so videos come from channel feeds and the search button opens YouTube.
