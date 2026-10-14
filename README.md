# El Niño Tracker

A live El Niño tracker on a 3D globe and map, in the style of [zoom.earth](https://zoom.earth/), built with **Python + Flask**, **Leaflet** and **MapLibre GL**.

**Live demo:** https://3dworldfreenow.github.io/weather/ (after GitHub Pages is enabled; see [Host the demo on GitHub Pages](#host-the-demo-on-github-pages))

## Features

- 📱 **Built for phones first:** the map or 3D globe fills the screen and everything else lives in a bottom sheet (drag or tap the handle: peek, half, full) with five tabs. Wide screens get a side panel; phones in landscape get a side sheet
- 📊 **Status:** current phase (El Niño / La Niña / neutral) and strength from the latest weekly Niño 3.4 anomaly, the 4-week trend, the four Niño regions with 12-week trend lines, NOAA's official Oceanic Niño Index, and where warming is strongest
- 🌍 **Impacts:** 57 countries coloured on the map and globe by their typical El Niño effect (drier, wetter, warmer winter, mixed). Tap a country for its season, what El Niño usually means there (rain, crops, water, energy, health), notable past events, its national weather service and the latest news about it. Plus worldwide themes: drought and fires, floods, heat, food and farming, health, oceans and coral, economy and energy, storms, forecasts
- 📰 **News:** El Niño news from GDELT and 35 Google News editions in 20 languages (Asia, Oceania, the Americas, Africa, the Middle East and Europe), plus worldwide searches per impact theme. Every headline is tagged by topic and by the countries it mentions; filter by topic, country, language or a search word. Videos from weather agencies play inside the site
- 📈 **History:** NOAA's Oceanic Niño Index since 1950 as an interactive chart (all, 30 or 10 years) and a table of every El Niño and La Niña episode with its peak and strength, found with NOAA's own rule
- 📘 **Learn:** plain-language answers to common questions
- 📰 **News page** (`/news/`): every El Niño item from 80+ free sources in one place: news (GDELT, 35 Google News editions, 13 Bing News markets), humanitarian reports (ReliefWeb), agency and science updates (NOAA Climate.gov, NASA Earth Observatory, UN News, Carbon Brief, Phys.org, ScienceDaily), new research papers (arXiv, Crossref), discussions (Hacker News), podcast episodes (Apple Podcasts) and videos. Filter by type, country, topic, crop, language or search; filters are kept in the link; a list shows which sources are working
- 🌾 **Crops page** (`/crops/`): how El Niño affects rice, wheat, maize, sugar, soybeans, coffee, cocoa, palm oil and cotton in 41 main growing regions. Pick a country and a crop or search: see the typical El Niño effect and crop calendar, the last 12 months of rain in the growing region against the long-term average (chart), the world price since 1990 with past El Niño periods shaded (chart), shown in each country's own currency per kg (or US$), and, and crop news (sugar, rice, coffee…) from around the world
- 🔎 **A page per country** (`/impacts/<country>/`, such as "El Niño impact on India") for search engines and sharing
- 🛰️ **Live Earth backdrop:** near-real-time imagery from five geostationary satellites (GOES-West, GOES-East, Meteosat 0°, Meteosat IODC, Himawari) in true colour or infrared, the daily sea surface temperature anomaly map, and live day/night shading
- 📚 **Sources panel** listing every data source, satellite, product and image time

All data sources are free and need **no API keys**:

| Data | Provider |
| --- | --- |
| Niño region indices (weekly) | [NOAA CPC weekly Niño SSTs](https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for) |
| Oceanic Niño Index (official, 3-month) | [NOAA CPC ONI](https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt) |
| Sea surface temperature anomaly map | [GHRSST MUR](https://podaac.jpl.nasa.gov/MEaSUREs-MUR) via [NASA GIBS](https://earthdata.nasa.gov/gibs) |
| Live satellites | GOES & Himawari via NASA GIBS, Meteosat via [EUMETView](https://view.eumetsat.int/) |
| World news | [GDELT](https://www.gdeltproject.org/) DOC API, [Google News](https://news.google.com/) RSS (35 editions + theme and crop searches), [Bing News](https://www.bing.com/news) RSS (13 markets) |
| Humanitarian reports | [ReliefWeb](https://reliefweb.int/) RSS (UN OCHA) |
| Agency and science updates | RSS feeds of [NOAA Climate.gov](https://www.climate.gov/enso), [NASA Earth Observatory](https://earthobservatory.nasa.gov/), [UN News](https://news.un.org/), [Carbon Brief](https://www.carbonbrief.org/), [Phys.org](https://phys.org/), [ScienceDaily](https://www.sciencedaily.com/) (El Niño items only) |
| Research papers | [arXiv](https://arxiv.org/) API, [Crossref](https://www.crossref.org/) API |
| Discussions and podcasts | [Hacker News](https://news.ycombinator.com/) (Algolia search API), [Apple Podcasts](https://podcasts.apple.com/) search API |
| Typical impacts by country | Summarised from [NOAA Climate.gov](https://www.climate.gov/enso), [WMO](https://wmo.int/topics/el-nino-la-nina), [IRI](https://iri.columbia.edu/our-expertise/climate/enso/) and national weather services |
| Country shapes | [Natural Earth](https://www.naturalearthdata.com/) via world-atlas (public domain) |
| Rainfall in growing regions | [NASA POWER](https://power.larc.nasa.gov/) (daily and long-term average) |
| World crop prices (monthly) | [IMF Primary Commodity Prices](https://www.imf.org/en/Research/commodity-prices) via [FRED](https://fred.stlouisfed.org/) |
| Exchange rates (daily, for local currencies) | [Rates by Exchange Rate API](https://www.exchangerate-api.com) (open access, no key) |
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
  news.py                  # El Niño news (GDELT, Google News) and videos (YouTube feeds), tagging
  crops.py                 # crops by country, growing-region rain (NASA POWER), world prices (FRED)
  impacts.py               # typical El Niño impacts by country and theme; topic/country tagging rules
  seo.py                   # page text, FAQ, structured data, sitemap, robots, manifest
  satellites.py            # live satellite layer discovery and stitching
  services.py              # HTTP helper and in-memory cache
  templates/index.html     # the app (pre-rendered content for search engines)
  templates/impact.html    # "El Niño impact on <country>" pages
  templates/news.html      # news page (all sources, filters)
  templates/crops.html     # El Niño and crops page
  static/data/countries.geojson  # country shapes (scripts/make_countries.py)
  static/css/style.css     # UI styles
  static/js/app.js         # map, globe, El Niño panel and overlays, live satellites
  static/js/news.js        # News page: filters, video player, source list
  static/js/crops.js       # Crops page: selection, search, rain and price charts, crop news
  static/js/static-api.js  # browser-only API used by the GitHub Pages demo
scripts/build_static.py    # builds the static demo into dist/
scripts/make_images.py     # draws the share image and app icons
scripts/make_countries.py  # converts world-atlas TopoJSON into countries.geojson
.github/workflows/pages.yml  # tests, builds and deploys the demo
tests/                     # tests (upstream calls are mocked)
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/enso` | El Niño status, Niño region anomalies, the full ONI history and episodes, and the SST anomaly map layer |
| `GET /api/satellites?style=truecolor\|infrared` | Live satellite layers, each with its longitude band, product and image time |
| `GET /api/news` | El Niño news, reports, science, papers, discussions and podcasts (each with a `kind`, tagged with `themes`, `countries` and `crops`) and videos, with the status of each source |
| `GET /impacts/<country>/` | Country page: typical El Niño impacts, past events, current status and latest news |
| `GET /news/` | News page |
| `GET /crops/` | Crops page |
| `GET /api/crops` | World crop prices (monthly since 1990) and today's exchange rates |
| `GET /api/crops/rain?region=<country>-<crop>` | Last 12 months of rain in a growing region against the long-term average |
| `GET /robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` | Search engine and app files |
| `GET /healthz` | Health check |

Satellite layer names are read from the NASA GIBS and EUMETView capability documents at run time, so changes on their side are picked up automatically. If a provider can't be reached, well-known layer names are used instead. Responses are cached in memory (El Niño data for 6 hours, news for 30 minutes). News links open the original publisher's site; YouTube's search API needs a key, so videos come from channel feeds and the search button opens YouTube.
