/* Browser-only implementation of the /api/* endpoints, used by the static
 * GitHub Pages demo where no Flask server runs.
 *
 * - Forecasts, grids, place search, radar: called directly from the browser
 *   (Open-Meteo and RainViewer allow cross-origin requests).
 * - Satellite layers, El Niño and events: read from data/*.json, which a
 *   scheduled GitHub Actions job builds with the same Python code as the server.
 *
 * Mirrors weather_app/services.py; keep the two in sync.
 */
(() => {
  "use strict";

  const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
  const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
  const RAINVIEWER_URL = "https://api.rainviewer.com/public/weather-maps.json";

  const GRID_LAYERS = {
    temperature: ["temperature_2m"],
    wind: ["wind_speed_10m", "wind_direction_10m"],
    precipitation: ["precipitation"],
    clouds: ["cloud_cover"],
    humidity: ["relative_humidity_2m"],
    pressure: ["pressure_msl"],
  };
  const GRID_COLS = 12;
  const GRID_MAX_ROWS = 10;
  const GRID_FORECAST_HOURS = 48;
  const GRID_STEP_HOURS = 3;
  const MAX_LAT = 85;

  const cache = new Map();
  async function cached(key, ttlMs, factory) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await factory();
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  async function getJson(url, params, signal) {
    const u = new URL(url, document.baseURI);
    Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u, { signal });
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 429) {
      throw new Error("The free weather data limit was reached. Please wait a minute and try again.");
    }
    if (!res.ok) {
      const reason = body && body.reason;
      throw new Error(reason ? `Weather data provider error: ${reason}` : `Request failed (${res.status})`);
    }
    return body;
  }

  // ---------------- forecast + search ----------------
  function weather({ lat, lon }, signal) {
    const params = {
      latitude: (+lat).toFixed(3),
      longitude: (+lon).toFixed(3),
      timezone: "auto",
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day",
      hourly: "temperature_2m,precipitation_probability,weather_code,wind_speed_10m,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset",
      forecast_hours: 24,
      forecast_days: 7,
    };
    return cached(`w:${params.latitude},${params.longitude}`, 600e3, () => getJson(FORECAST_URL, params, signal));
  }

  async function search({ q }, signal) {
    q = (q || "").trim();
    if (q.length < 2) return { results: [] };
    const data = await cached(`s:${q.toLowerCase()}`, 3600e3,
      () => getJson(GEOCODING_URL, { name: q, count: 8, language: "en", format: "json" }, signal));
    return {
      results: (data.results || []).map((r) => ({
        name: r.name, admin1: r.admin1, country: r.country, country_code: r.country_code,
        lat: r.latitude, lon: r.longitude,
      })),
    };
  }

  // ---------------- forecast grid ----------------
  const latToMerc = (lat) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180) / 2));
  const mercToLat = (y) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

  function snapBbox(south, west, north, east) {
    const span = Math.max(east - west, (north - south) / 2, 0.5);
    let step = Math.pow(2, Math.floor(Math.log2(span / 4)));
    step = Math.min(Math.max(step, 0.25), 90);
    west = Math.floor(west / step) * step;
    east = Math.ceil(east / step) * step;
    south = Math.max(-MAX_LAT, Math.floor(south / step) * step);
    north = Math.min(MAX_LAT, Math.ceil(north / step) * step);
    if (east - west >= 360) { west = -180; east = 180; }
    else if (west < -180 || west >= 180) {
      const shift = Math.floor((west + 180) / 360) * 360;
      west -= shift; east -= shift;
    }
    return [south, west, north, east];
  }

  function gridPoints(south, west, north, east) {
    const yS = latToMerc(south), yN = latToMerc(north);
    const widthRad = (east - west) * Math.PI / 180;
    const aspect = widthRad > 0 ? (yN - yS) / widthRad : 1;
    const rows = Math.max(4, Math.min(GRID_MAX_ROWS, Math.round(GRID_COLS * aspect)));
    const lons = Array.from({ length: GRID_COLS }, (_, i) => west + (east - west) * (i + 0.5) / GRID_COLS);
    const lats = Array.from({ length: rows }, (_, j) => mercToLat(yN - (yN - yS) * (j + 0.5) / rows));
    return { lats, lons };
  }

  async function fetchGrid(south, west, north, east, signal) {
    const { lats, lons } = gridPoints(south, west, north, east);
    const pLat = [], pLon = [];
    lats.forEach((la) => lons.forEach((lo) => {
      pLat.push(la.toFixed(3));
      pLon.push((((lo + 180) % 360 + 360) % 360 - 180).toFixed(3));
    }));
    const variables = [...new Set(Object.values(GRID_LAYERS).flat())].sort();
    let data = await getJson(FORECAST_URL, {
      latitude: pLat.join(","), longitude: pLon.join(","), hourly: variables.join(","),
      forecast_hours: GRID_FORECAST_HOURS, timezone: "GMT", timeformat: "unixtime", wind_speed_unit: "kmh",
    }, signal);
    if (!Array.isArray(data)) data = [data];
    if (data.length !== pLat.length) throw new Error("Unexpected forecast grid response");
    const times = data[0].hourly.time.filter((_, i) => i % GRID_STEP_HOURS === 0);
    const rows = lats.length, cols = lons.length;
    const fields = {};
    variables.forEach((v) => {
      const per = data.map((loc) => loc.hourly[v].filter((_, i) => i % GRID_STEP_HOURS === 0));
      fields[v] = times.map((_, t) => Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => per[r * cols + c][t])));
    });
    return { bounds: { south, west, north, east }, rows, cols, times, fields };
  }

  async function grid({ layer, south, west, north, east }, signal) {
    if (!GRID_LAYERS[layer]) throw new Error(`Unknown layer '${layer}'`);
    const [s, w, n, e] = snapBbox(+south, +west, +north, +east);
    const raw = await cached(`g:${s},${w},${n},${e}`, 1800e3, () => fetchGrid(s, w, n, e, signal));
    const out = { bounds: raw.bounds, rows: raw.rows, cols: raw.cols, times: raw.times, layer,
      global: raw.bounds.east - raw.bounds.west >= 360 };
    if (layer !== "wind") { out.values = raw.fields[GRID_LAYERS[layer][0]]; return out; }
    const sp = raw.fields.wind_speed_10m, dir = raw.fields.wind_direction_10m;
    const vec = (fn) => sp.map((f, t) => f.map((row, r) => row.map((s0, c) => {
      const d = dir[t][r][c];
      return s0 == null || d == null ? null : Math.round(fn(s0, d * Math.PI / 180) * 100) / 100;
    })));
    out.values = sp;
    out.u = vec((s0, rad) => -s0 * Math.sin(rad));
    out.v = vec((s0, rad) => -s0 * Math.cos(rad));
    return out;
  }

  // ---------------- radar ----------------
  function radar(_, signal) {
    return cached("radar", 120e3, async () => {
      const data = await getJson(RAINVIEWER_URL, {}, signal);
      const r = data.radar || {};
      const frames = [
        ...(r.past || []).map((f) => ({ time: f.time, path: f.path, nowcast: false })),
        ...(r.nowcast || []).map((f) => ({ time: f.time, path: f.path, nowcast: true })),
      ];
      return { host: data.host || "https://tilecache.rainviewer.com", frames };
    });
  }

  // ---------------- pre-built data files ----------------
  const dataFile = (name) => cached(`file:${name}`, 300e3, () => getJson(`data/${name}`, { v: Math.floor(Date.now() / 300e3) }));

  // Same rule as satellites.latest_image_time(): newest 10-minute slot, 40 min ago.
  function latestImageTime() {
    const d = new Date(Date.now() - 40 * 60e3);
    d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % 10), 0, 0);
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  async function satellites({ style }) {
    const data = await dataFile("satellites.json");
    const set = data.styles[style] || data.styles.infrared;
    const time = latestImageTime();
    return {
      time, style,
      layers: set.layers.map((l) => ({ ...l, time, url: l.url.replace("{time}", time) })),
    };
  }

  // Events are optional: show none if the last build could not fetch them.
  const events = () => dataFile("events.json").catch(() => ({ events: [] }));
  const enso = () => dataFile("enso.json");

  const ROUTES = {
    "/api/weather": weather, "/api/search": search, "/api/grid": grid, "/api/radar": radar,
    "/api/satellites": satellites, "/api/events": events, "/api/enso": enso,
  };

  window.StaticApi = {
    handle(path, params, signal) {
      const fn = ROUTES[path];
      if (!fn) return Promise.reject(new Error(`No static handler for ${path}`));
      return fn(params || {}, signal);
    },
  };
})();
