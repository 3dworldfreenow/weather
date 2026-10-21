/* Live weather globe (home page), in the style of zoom.earth.
 *
 * Maps (one at a time): live satellite (stitched from five geostationary satellites,
 * with a 24-hour replay in 30-minute steps), rain radar (RainViewer), forecast maps
 * drawn from a global Open-Meteo grid (precipitation, wind, temperature, humidity,
 * pressure) and the El Niño sea temperature anomaly.
 * Overlays: wind animation, city temperatures, labels, borders, night, grid, Niño regions.
 * The live map refreshes every 5 minutes.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STATIC_SITE = Boolean(window.APP_CONFIG && window.APP_CONFIG.static);
  const MAPLIBRE = {
    js: "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js",
    jsSri: "sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp",
    css: "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css",
    cssSri: "sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK",
  };
  const RAINVIEWER = "https://api.rainviewer.com/public/weather-maps.json";
  const SAT_LAT_LIMIT = 81;          // edge of the geostationary disks
  const SAT_LATENCY_MIN = 40;        // images appear about 40 minutes after they are taken
  const REPLAY_HOURS = 24;
  const REPLAY_STEP_MIN = 30;
  const REFRESH_MS = 5 * 60e3;       // check for new satellite images every 5 minutes
  // Radar: RainViewer adds an image every 10 minutes, so look every 2 (tests may shorten it).
  const RADAR_REFRESH_MS = (window.WX_TEST && window.WX_TEST.radarRefreshMs) || 2 * 60e3;
  const MERC_LAT = 85.0511;
  const MERC_CORNERS = [[-180, MERC_LAT], [180, MERC_LAT], [180, -MERC_LAT], [-180, -MERC_LAT]];
  const FORECAST_MAPS = ["rain", "wind", "temp", "humidity", "pressure"];
  const MAP_NAMES = { satellite: "Satellite", radar: "Radar", rain: "Precipitation", wind: "Wind", temp: "Temperature",
    humidity: "Humidity", pressure: "Pressure", sst: "Sea temperature" };

  // Colour scales: [value, [r, g, b, alpha 0..1]]
  const SCALES = {
    temp: { unit: "°C", opacity: 0.72, stops: [[-40, [107, 44, 145, 1]], [-25, [63, 81, 181, 1]], [-10, [33, 150, 243, 1]],
      [0, [129, 212, 250, 1]], [10, [102, 187, 106, 1]], [20, [253, 216, 53, 1]], [30, [251, 140, 0, 1]],
      [40, [229, 57, 53, 1]], [50, [123, 31, 31, 1]]] },
    rain: { unit: "mm / 3 h", opacity: 0.85, stops: [[0, [0, 0, 0, 0]], [0.2, [129, 212, 250, 0.35]], [1, [41, 182, 246, 0.7]],
      [3, [30, 136, 229, 0.85]], [8, [94, 53, 177, 0.9]], [15, [216, 27, 96, 0.95]], [30, [229, 57, 53, 1]], [60, [255, 235, 59, 1]]] },
    wind: { unit: "km/h", opacity: 0.72, stops: [[0, [59, 76, 192, 1]], [10, [44, 123, 182, 1]], [20, [0, 166, 202, 1]],
      [30, [0, 204, 188, 1]], [45, [144, 235, 157, 1]], [60, [255, 255, 140, 1]], [80, [249, 208, 87, 1]],
      [100, [242, 158, 46, 1]], [130, [231, 104, 24, 1]], [160, [215, 25, 28, 1]]] },
    humidity: { unit: "%", opacity: 0.68, stops: [[0, [140, 81, 10, 1]], [25, [216, 179, 101, 1]], [50, [246, 232, 195, 1]],
      [70, [128, 205, 193, 1]], [85, [53, 151, 143, 1]], [100, [1, 102, 94, 1]]] },
    pressure: { unit: "hPa", opacity: 0.68, stops: [[960, [106, 27, 154, 1]], [985, [30, 136, 229, 1]], [1000, [129, 212, 250, 1]],
      [1013, [245, 245, 245, 1]], [1022, [255, 204, 128, 1]], [1035, [230, 81, 0, 1]], [1050, [150, 30, 0, 1]]] },
  };

  const state = { map: "satellite", style: "truecolor", rvClouds: true, overlays: new Set(["temps", "labels", "borders", "night"]),
    frame: 0, playing: false, live: true };
  const data = { sats: {}, forecast: null, radar: null, enso: null };
  let gm = null;
  let ready = false;
  let mapLayerIds = [];

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const isoMinute = (d) => d.toISOString().replace(/:\d{2}\.\d{3}Z$/, ":00Z");
  const staticBase = (() => {
    const css = document.querySelector('link[href*="css/style.css"]');
    return css ? css.href.replace(/css\/style\.css.*$/, "") : `${window.location.origin}/static/`;
  })();

  function status(msg, ms = 4000) {
    const el = $("wx-status");
    el.textContent = msg;
    el.hidden = !msg;
    clearTimeout(status.t);
    if (msg && ms) status.t = setTimeout(() => { el.hidden = true; }, ms);
  }

  async function getJson(staticName, apiPath) {
    const url = STATIC_SITE ? `data/${staticName}?v=${Math.floor(Date.now() / 300e3)}` : apiPath;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${staticName} not available (${res.status})`);
    return res.json();
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  async function loadSatellites(style) {
    if (data.sats[style]) return data.sats[style];
    let layers;
    if (STATIC_SITE) {
      const d = await getJson("satellites.json", "");
      layers = (d.styles[style] || d.styles.infrared).layers;
    } else {
      layers = (await getJson("", `/api/satellites?style=${style}`)).layers;
    }
    // Keep a {time} placeholder in every URL so any time can be shown (live or replay).
    data.sats[style] = layers.map((l) => ({ ...l, url: l.url.includes("{time}") || !l.time ? l.url : l.url.split(l.time).join("{time}") }));
    return data.sats[style];
  }

  const loadForecast = async () => { data.forecast = await getJson("forecast.json", "/api/forecast"); return data.forecast; };
  const loadEnso = async () => { data.enso = await getJson("enso.json", "/api/enso"); return data.enso; };
  async function loadRadar() {
    const res = await fetch(`${RAINVIEWER}?t=${Math.floor(Date.now() / 60e3)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Radar not available (${res.status})`);
    data.radar = await res.json();
    data.radarCheckedAt = new Date();
    return data.radar;
  }

  // Predicted radar for the next hour, made on our server every 10 minutes
  // (weather_app/radar_nowcast.py): frames of map tiles plus motion per area.
  async function loadNowcast() {
    try {
      const nc = await getJson("nowcast.json", "/api/nowcast");
      if (nc && nc.frames) {
        nc.frames.forEach((f) => { f.tileSet = new Set(f.tiles); });
        data.nowcast = nc;
      }
    } catch (e) { /* keep the previous prediction */ }
    return data.nowcast;
  }

  // Live radar: look for a new image every 2 minutes while the radar is shown.
  async function refreshRadar() {
    if (!ready || state.map !== "radar") return;
    const before = frames();
    const shownTime = before[state.frame];
    const lastBefore = before[radarLiveIndex()];
    try { await Promise.all([loadRadar(), loadNowcast()]); } catch (e) { renderTimeBar(); return; }
    const after = frames();
    const lastAfter = after[radarLiveIndex()];
    if (state.live || state.playing) state.frame = state.live ? radarNowIndex() : Math.min(state.frame, after.length - 1);
    else {
      // Replaying: stay on the same moment (the list shifts when a new image arrives).
      const i = after.findIndex((t) => +t === +shownTime);
      state.frame = i >= 0 ? i : 0;
    }
    if (lastAfter && lastBefore && +lastAfter > +lastBefore) status(`New radar image ${fmtClock(lastAfter)}`, 2500);
    drawFrame();
  }
  setInterval(refreshRadar, RADAR_REFRESH_MS);

  // ------------------------------------------------------------------
  // Time frames for the current map
  // ------------------------------------------------------------------
  function latestSatTime(now = new Date()) {
    const d = new Date(now.getTime() - SAT_LATENCY_MIN * 60e3);
    d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % 10), 0, 0);
    return d;
  }

  function frames() {
    if (state.map === "satellite") {
      const latest = latestSatTime();
      const n = (REPLAY_HOURS * 60) / REPLAY_STEP_MIN;
      return Array.from({ length: n + 1 }, (_, i) => new Date(latest.getTime() - (n - i) * REPLAY_STEP_MIN * 60e3));
    }
    if (state.map === "radar") return radarFrames().map((f) => new Date(f.time * 1000));
    if (state.map === "sst") return data.enso ? [new Date(`${data.enso.sst_layer.date}T12:00:00Z`)] : [];
    return data.forecast ? data.forecast.times.map((t) => new Date(t)) : [];
  }

  // Radar images: the past ~2 hours, then our server's predicted images after the
  // newest real one (or RainViewer's short nowcast if it offers one).
  function radarFrames() {
    const r = (data.radar && data.radar.radar) || {};
    const past = r.past || [];
    const latest = past[past.length - 1];
    const ours = ((data.nowcast && data.nowcast.frames) || []).filter((f) => latest && f.time > latest.time);
    const extra = ours.length ? ours.map((f) => ({ ...f, predicted: true }))
      : (r.nowcast || []).map((f) => ({ ...f, nowcast: true }));
    return [...past, ...extra];
  }
  // Newest real radar image.
  const radarLiveIndex = () => Math.max(0, ((data.radar && data.radar.radar && data.radar.radar.past) || []).length - 1);
  // "Now" on the radar: the predicted image for the current time when there is one
  // (radar images arrive 10–30 min late), else the newest real image.
  function radarNowIndex() {
    const list = radarFrames(), now = Date.now() / 1000 + 150;
    let i = radarLiveIndex();
    while (i + 1 < list.length && list[i + 1].predicted && list[i + 1].time <= now) i++;
    return i;
  }
  const liveIndex = (list) => (state.map === "radar" ? radarNowIndex() : Math.max(0, list.length - 1));

  function defaultFrame(list) {
    if (!FORECAST_MAPS.includes(state.map)) return liveIndex(list);
    const now = Date.now() - 90 * 60e3;
    const i = list.findIndex((t) => t.getTime() >= now);
    return i < 0 ? 0 : i;
  }

  // Forecast frame closest to a time (for overlays shown on other maps).
  function forecastIndexAt(time) {
    if (!data.forecast) return -1;
    let best = 0;
    data.forecast.times.forEach((t, i) => {
      if (Math.abs(new Date(t) - time) < Math.abs(new Date(data.forecast.times[best]) - time)) best = i;
    });
    return best;
  }
  const currentTime = () => frames()[state.frame] || new Date();
  const forecastFrame = () => (FORECAST_MAPS.includes(state.map) ? state.frame : forecastIndexAt(currentTime()));

  // ------------------------------------------------------------------
  // Forecast grid sampling and colour maps
  // ------------------------------------------------------------------
  function sample(field, lat, lon) {
    const g = data.forecast.grid;
    const r = (lat - g.lat0) / g.dlat;
    let c = (lon - g.lon0) / g.dlon;
    c = ((c % g.nlon) + g.nlon) % g.nlon;
    const r0 = Math.max(0, Math.min(g.nlat - 1, Math.floor(r)));
    const r1 = Math.min(g.nlat - 1, r0 + 1);
    const c0 = Math.floor(c) % g.nlon;
    const c1 = (c0 + 1) % g.nlon;
    const fr = Math.max(0, Math.min(1, r - r0));
    const fc = c - Math.floor(c);
    const v = (rr, cc) => field[rr * g.nlon + cc];
    const a = v(r0, c0), b = v(r0, c1), d = v(r1, c0), e = v(r1, c1);
    if (a == null || b == null || d == null || e == null) return a ?? b ?? d ?? e ?? null;
    return (a * (1 - fc) + b * fc) * (1 - fr) + (d * (1 - fc) + e * fc) * fr;
  }

  // Wind as u/v components (km/h, towards east / north), cached per forecast frame so
  // the animation can interpolate smoothly (no jump where the direction wraps 359°→0°).
  const uvCache = new Map();
  function uvFields(f) {
    const key = `${data.forecast.built_at}:${f}`;
    if (!uvCache.has(key)) {
      const sp = data.forecast.fields.wind[f], dir = data.forecast.fields.wind_dir[f];
      const u = sp.map((v, i) => (v == null || dir[i] == null ? null : -v * Math.sin((dir[i] * Math.PI) / 180)));
      const v = sp.map((x, i) => (x == null || dir[i] == null ? null : -x * Math.cos((dir[i] * Math.PI) / 180)));
      if (uvCache.size > 4) uvCache.delete(uvCache.keys().next().value);
      uvCache.set(key, { u, v });
    }
    return uvCache.get(key);
  }

  function windAt(f, lat, lon) {
    const { u: U, v: V } = uvFields(f);
    const u = sample(U, lat, lon), v = sample(V, lat, lon);
    if (u == null || v == null) return null;
    const speed = Math.hypot(u, v);
    const dir = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360; // where it comes from
    return { speed, u, v, dir };
  }

  function color(scale, v) {
    const s = scale.stops;
    if (v <= s[0][0]) return s[0][1];
    for (let i = 1; i < s.length; i++) {
      if (v <= s[i][0]) {
        const t = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
        return s[i - 1][1].map((x, k) => x + (s[i][1][k] - x) * t);
      }
    }
    return s[s.length - 1][1];
  }

  const mercLat = (y, h) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / h))) * 180) / Math.PI;
  const imageCache = new Map();

  // Draw the other frames of a forecast map while the browser is idle, so playing
  // through them never stalls on drawing.
  let warmFor = "";
  function warmForecast(map) {
    if (!data.forecast || warmFor === map) return;
    warmFor = map;
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 50));
    let f = 0;
    const step = () => {
      if (warmFor !== map || state.map !== map || f >= data.forecast.times.length) { warmFor = ""; return; }
      forecastImage(map, f++);
      idle(step);
    };
    idle(step);
  }

  function forecastImage(map, f) {
    const key = `${data.forecast.built_at}:${map}:${f}`;
    if (imageCache.has(key)) return imageCache.get(key);
    const W = 720, H = 720;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const scale = SCALES[map];
    const field = data.forecast.fields[map][f];
    for (let y = 0; y < H; y++) {
      const lat = mercLat(y + 0.5, H);
      for (let x = 0; x < W; x++) {
        const v = sample(field, lat, -180 + ((x + 0.5) / W) * 360);
        const o = (y * W + x) * 4;
        if (v == null) { img.data[o + 3] = 0; continue; }
        const [r, g, b, a] = color(scale, v);
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL("image/png");
    if (imageCache.size > 60) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(key, url);
    return url;
  }

  // ------------------------------------------------------------------
  // Globe
  // ------------------------------------------------------------------
  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const css = document.createElement("link");
      Object.assign(css, { rel: "stylesheet", href: MAPLIBRE.css, integrity: MAPLIBRE.cssSri, crossOrigin: "" });
      document.head.appendChild(css);
      const js = document.createElement("script");
      Object.assign(js, { src: MAPLIBRE.js, integrity: MAPLIBRE.jsSri, crossOrigin: "" });
      js.onload = resolve;
      js.onerror = () => reject(new Error("Could not load the globe library."));
      document.head.appendChild(js);
    });
  }

  function sunPosition(date) {
    const rad = Math.PI / 180;
    const n = date.getTime() / 864e5 + 2440587.5 - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * rad;
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
    const eps = (23.439 - 0.0000004 * n) * rad;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    const lon = ((((ra / rad - gmst * 15) + 540) % 360) + 360) % 360 - 180;
    return { lat: dec / rad, lon };
  }

  function nightGeoJSON(date) {
    const rad = Math.PI / 180;
    const sun = sunPosition(date);
    let dec = sun.lat * rad;
    if (Math.abs(dec) < 0.001) dec = 0.001;
    const ring = [];
    for (let lon = -180; lon <= 180; lon += 2) ring.push([lon, Math.atan(-Math.cos((lon - sun.lon) * rad) / Math.tan(dec)) / rad]);
    const pole = dec > 0 ? -89.9 : 89.9;
    ring.push([180, pole], [-180, pole], ring[0]);
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
  }

  function gridGeoJSON() {
    const features = [];
    for (let lon = -180; lon < 180; lon += 15) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "LineString",
        coordinates: Array.from({ length: 35 }, (_, i) => [lon, -85 + i * 5]) } });
    }
    for (let lat = -75; lat <= 75; lat += 15) {
      features.push({ type: "Feature", properties: { equator: lat === 0 }, geometry: { type: "LineString",
        coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]) } });
    }
    return { type: "FeatureCollection", features };
  }

  const splitBand = ([w, e]) => (e > 180 ? [[w, 180], [-180, e - 360]] : w < -180 ? [[w + 360, 180], [-180, e]] : [[w, e]]);

  function ninoGeoJSON() {
    const features = [];
    ((data.enso && data.enso.regions) || []).forEach((r) => {
      splitBand([r.west, r.east]).forEach(([w, e]) => features.push({
        type: "Feature", properties: { warm: r.anomaly >= 0.5, cool: r.anomaly <= -0.5 },
        geometry: { type: "Polygon", coordinates: [[[w, r.south], [e, r.south], [e, r.north], [w, r.north], [w, r.south]]] },
      }));
    });
    return { type: "FeatureCollection", features };
  }

  function createGlobe() {
    const startCenter = (() => {
      try { return JSON.parse(localStorage.getItem("wx-view")) || null; } catch (e) { return null; }
    })();
    maplibregl.addProtocol("wxradar", radarProtocol);
    maplibregl.addProtocol("wxnc", ncProtocol);
    if (maplibregl.setMaxParallelImageRequests) maplibregl.setMaxParallelImageRequests(32); // radar loops load many small tiles
    gm = new maplibregl.Map({
      container: "wx-globe",
      center: startCenter ? startCenter.center : [78, 20],
      zoom: startCenter ? startCenter.zoom : (window.innerWidth < 600 ? 1.4 : 2.2),
      maxZoom: 17, // close enough to see villages and streets
      attributionControl: false,
      style: {
        version: 8,
        projection: { type: "globe" },
        sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] },
        sources: {
          imagery: { type: "raster", tileSize: 256, maxzoom: 19,
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" },
          labels: { type: "raster", tileSize: 256, maxzoom: 16,
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"] },
          night: { type: "geojson", data: nightGeoJSON(new Date()) },
          grid: { type: "geojson", data: gridGeoJSON() },
          borders: { type: "geojson", data: `${staticBase}data/countries.geojson` },
          nino: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        },
        layers: [
          { id: "space", type: "background", paint: { "background-color": "#0b1d36" } },
          { id: "imagery", type: "raster", source: "imagery" },
          { id: "anchor-map", type: "background", layout: { visibility: "none" } },
          { id: "night", type: "fill", source: "night", paint: { "fill-color": "#000814", "fill-opacity": 0.4 } },
          { id: "borders", type: "line", source: "borders", paint: { "line-color": "rgba(255,255,255,0.55)", "line-width": 0.8 } },
          { id: "grid", type: "line", source: "grid",
            paint: { "line-color": "rgba(255,255,255,0.35)", "line-width": ["case", ["==", ["get", "equator"], true], 1.4, 0.6] } },
          { id: "nino-fill", type: "fill", source: "nino",
            paint: { "fill-color": ["case", ["==", ["get", "warm"], true], "#ff5a3c", ["==", ["get", "cool"], true], "#4d8dff", "#ffffff"], "fill-opacity": 0.12 } },
          { id: "nino-line", type: "line", source: "nino",
            paint: { "line-color": ["case", ["==", ["get", "warm"], true], "#ff5a3c", ["==", ["get", "cool"], true], "#4d8dff", "#ffffff"], "line-width": 2 } },
          { id: "anchor-wind", type: "background", layout: { visibility: "none" } },
          { id: "labels", type: "raster", source: "labels" },
        ],
      },
    });
    window.wxGlobe = gm; // handy for debugging in the browser console
    gm.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    gm.addControl(new maplibregl.AttributionControl({ compact: true,
      customAttribution: "Satellites: NASA GIBS, EUMETSAT · Radar: RainViewer · Stations: NOAA AWC · Forecast: Open-Meteo · Places: © OpenStreetMap (Nominatim)" }), "bottom-right");
    gm.on("load", () => {
      ready = true;
      const attrib = gm.getContainer().querySelector(".maplibregl-ctrl-attrib");
      if (attrib) attrib.classList.remove("maplibregl-compact-show");
      applyOverlays();
      showMap();
    });
    gm.on("moveend", () => {
      try { localStorage.setItem("wx-view", JSON.stringify({ center: gm.getCenter().toArray(), zoom: gm.getZoom() })); } catch (e) { /* private mode */ }
    });
    gm.on("click", (e) => showPointInfo(e.lngLat));
    gm.on("move", queueDeclutter);
  }

  // ------------------------------------------------------------------
  // The selected map
  // ------------------------------------------------------------------
  function clearMapLayers() {
    mapLayerIds.forEach((id) => { if (gm.getLayer(id)) gm.removeLayer(id); if (gm.getSource(id)) gm.removeSource(id); });
    mapLayerIds = [];
  }

  function addRaster(id, source, opacity = 1, fade = null, extra = {}) {
    gm.addSource(id, source);
    const paint = { "raster-opacity": opacity, "raster-fade-duration": 0, ...extra };
    if (fade) paint["raster-opacity-transition"] = fade;
    gm.addLayer({ id, type: "raster", source: id, paint }, "anchor-map");
    mapLayerIds.push(id);
  }

  function satTiles(sat, time) {
    const t = time.toISOString().replace(/\.\d{3}Z$/, "Z");
    if (sat.type === "wms") {
      const q = new URLSearchParams({ service: "WMS", request: "GetMap", layers: sat.layer, styles: "", format: "image/png",
        transparent: "true", version: "1.3.0", width: "256", height: "256", crs: "EPSG:3857", time: t });
      return [`${sat.url}?${q}&bbox={bbox-epsg-3857}`];
    }
    return [sat.url.replace("{time}", t)];
  }

  // Infrared satellite slot for a radar time (satellite images arrive later than radar,
  // so newer and predicted radar frames get the newest satellite image).
  function cloudTime(time) {
    const d = new Date(Math.min(time.getTime(), latestSatTime().getTime()));
    d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % 30), 0, 0); // 30-min slots: fewer images to load
    return d;
  }
  function eachBand(sats, fn) { sats.forEach((sat) => splitBand(sat.band).forEach((band, i) => fn(sat, band, i))); }

  // Radar tiles go through the wxradar: protocol (below) to be recoloured and smoothed.
  const radarUrl = (f) => [`wxradar://${data.radar.host.replace(/^https?:\/\//, "")}${f.path}/256/{z}/{x}/{y}/2/0_0.png`];

  /* RainViewer's tiles are read back to rain intensity and redrawn in our colours with
   * soft edges (in a worker), so zoomed-in radar shows smooth rain areas, not blocks. */
  const canRecolor = Boolean(window.Worker && window.OffscreenCanvas && window.createImageBitmap);
  let tileTurn = 0;
  const radarProtocol = async (params) => {
    const url = params.url.replace("wxradar://", "https://");
    const w = canRecolor && workerFor("tile", tileTurn++ % 2);
    if (w) {
      try {
        const r = await callWorker(w, { kind: "tile", url, ramp: RAIN_RAMP, threshold: NC.threshold, blur: 1.2 });
        return { data: r.bitmap };
      } catch (e) { /* fall back to the original tile */ }
    }
    const res = await fetch(url.replace("/2/0_0.png", "/2/1_1.png"));
    if (!res.ok) throw new Error(`Radar tile ${res.status}`);
    return { data: await res.arrayBuffer() };
  };

  /* Radar: every image of the loop is its own layer, loaded once; moving through time
   * only changes which layer is visible (with a short cross-fade), so playing is smooth
   * and never waits for tiles. Infrared clouds underneath work the same way, one layer
   * set per 30-minute satellite slot. */
  // Predicted tiles exist only where it rains: others are answered with an empty image
  // without asking the server.
  let emptyTile = null;
  const ncProtocol = async (params) => {
    const rel = params.url.replace("wxnc://", "");
    const m = rel.match(/^(.*)\/(\d+\/\d+\/\d+)\.png$/);
    const f = m && ((data.nowcast && data.nowcast.frames) || []).find((x) => x.path === m[1]);
    if (!f || !f.tileSet.has(m[2])) {
      emptyTile = emptyTile || (await createImageBitmap(new ImageData(1, 1)));
      return { data: emptyTile };
    }
    const res = await fetch(new URL(rel, document.baseURI));
    if (!res.ok) throw new Error(`Predicted tile ${res.status}`);
    return { data: await res.arrayBuffer() };
  };

  const FADE = { duration: 250, delay: 0 };
  let radarKey = "";
  function setOpacity(id, v) {
    if (gm.getLayer(id) && gm.getPaintProperty(id, "raster-opacity") !== v) gm.setPaintProperty(id, "raster-opacity", v);
  }
  // Darker, greyer ground under the radar so clouds and rain stand out (like zoom.earth).
  function dimGround(on) {
    if (!gm.getLayer("imagery")) return;
    gm.setPaintProperty("imagery", "raster-brightness-max", on ? 0.55 : 1);
    gm.setPaintProperty("imagery", "raster-saturation", on ? -0.5 : 0);
  }

  async function drawRadar(time, rebuild) {
    const past = data.radar.radar.past || [];
    const clouds = state.rvClouds ? await loadSatellites("infrared") : null;
    if (!data.nowcast && (await loadNowcast()) && state.live && !state.playing) {
      state.frame = radarNowIndex(); // the prediction adds frames: Live = the estimate for now
      renderTimeBar();
    }
    const preds = radarFrames().filter((f) => f.predicted);
    const key = past.map((f) => f.path).join() + "|" + preds.map((f) => f.path).join() + (clouds ? "|clouds" : "");
    if (rebuild || key !== radarKey || !gm.getLayer("radar-0")) {
      clearMapLayers();
      radarKey = key;
      past.forEach((f, i) => addRaster(`radar-${i}`, { type: "raster", tiles: radarUrl(f), tileSize: 256, maxzoom: 7,
        attribution: '<a href="https://www.rainviewer.com/">RainViewer</a>' }, 0, FADE));
      // Predicted images (our server), preloaded the same way.
      preds.forEach((f, k) => addRaster(`nc-${k}`, { type: "raster", tiles: [`wxnc://${f.path}/{z}/{x}/{y}.png`], tileSize: 256,
        maxzoom: data.nowcast.zoom }, 0, FADE));
    }
    const frame = radarFrames()[state.frame] || {};
    const k = frame.predicted ? preds.findIndex((f) => f.time === frame.time) : -1;
    preds.forEach((_, i) => setOpacity(`nc-${i}`, i === k ? 0.9 : 0));
    const real = frame.predicted ? -1 : Math.min(state.frame, past.length - 1);
    past.forEach((_, i) => setOpacity(`radar-${i}`, i === real ? 0.85 : 0));
    if (clouds) {
      // Clouds of the 30-minute satellite slot shown, added when first needed and then
      // kept, so radar tiles load first and replaying again is smooth.
      const slot = +cloudTime(time);
      if (!gm.getLayer(`cl-${slot}-${clouds[0].id}-0`)) {
        eachBand(clouds, (sat, [w, e], i) => {
          const id = `cl-${slot}-${sat.id}-${i}`;
          gm.addSource(id, { type: "raster", tiles: satTiles(sat, new Date(slot)), tileSize: 256, maxzoom: sat.max_native_zoom,
            bounds: [w, -SAT_LAT_LIMIT, e, SAT_LAT_LIMIT], attribution: sat.attribution });
          // Bright white clouds: infrared with more contrast (cold cloud tops white, warm ground dark).
          gm.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0, "raster-fade-duration": 0,
            "raster-opacity-transition": FADE, "raster-contrast": 0.45, "raster-brightness-min": 0.08, "raster-saturation": -1 } }, "radar-0");
          mapLayerIds.push(id);
        });
      }
      mapLayerIds.filter((id) => id.startsWith("cl-")).forEach((id) => setOpacity(id, id.startsWith(`cl-${slot}-`) ? 0.8 : 0));
    }
  }


  // Draw the current frame; when only the time changed, swap tiles in place.
  async function drawFrame(rebuild = false) {
    if (!ready) return;
    const time = currentTime();
    const m = state.map;
    dimGround(m === "radar");
    try {
      if (m === "satellite") {
        const sats = await loadSatellites(state.style);
        if (rebuild || !mapLayerIds.length) {
          clearMapLayers();
          sats.forEach((sat) => splitBand(sat.band).forEach(([w, e], i) => addRaster(`sat-${sat.id}-${i}`, {
            type: "raster", tiles: satTiles(sat, time), tileSize: 256, maxzoom: sat.max_native_zoom,
            bounds: [w, -SAT_LAT_LIMIT, e, SAT_LAT_LIMIT], attribution: sat.attribution,
          }, sat.style === "infrared" ? 0.7 : 1)));
        } else {
          sats.forEach((sat) => splitBand(sat.band).forEach((_, i) => {
            const src = gm.getSource(`sat-${sat.id}-${i}`);
            if (src && src.setTiles) src.setTiles(satTiles(sat, time));
          }));
        }
      } else if (m === "radar") {
        if (!data.radar) await loadRadar();
        await drawRadar(time, rebuild);
      } else if (m === "sst") {
        if (rebuild || !gm.getSource("sst")) {
          clearMapLayers();
          const l = data.enso.sst_layer;
          addRaster("sst", { type: "raster", tiles: [l.url], tileSize: 256, maxzoom: l.max_native_zoom, attribution: l.attribution }, 0.85);
        }
      } else {
        const url = forecastImage(m, state.frame);
        if (rebuild || !gm.getSource("forecast")) {
          clearMapLayers();
          gm.addSource("forecast", { type: "image", url, coordinates: MERC_CORNERS });
          gm.addLayer({ id: "forecast", type: "raster", source: "forecast",
            paint: { "raster-opacity": SCALES[m].opacity, "raster-fade-duration": 0, "raster-resampling": "linear" } }, "anchor-map");
          mapLayerIds.push("forecast");
        } else gm.getSource("forecast").updateImage({ url, coordinates: MERC_CORNERS });
        warmForecast(m);
      }
    } catch (err) {
      status(err.message);
    }
    if (state.overlays.has("night")) gm.getSource("night").setData(nightGeoJSON(m === "satellite" || m === "radar" ? time : new Date()));
    updateCityTemps();
    renderTimeBar();
  }

  async function showMap() {
    try {
      if (FORECAST_MAPS.includes(state.map) && !data.forecast) await loadForecast();
      if (state.map === "radar" && !data.radar) await loadRadar();
      if (state.map === "sst" && !data.enso) await loadEnso();
    } catch (err) {
      status(`${MAP_NAMES[state.map]} is not available right now (${err.message}).`, 6000);
    }
    const list = frames();
    state.frame = defaultFrame(list);
    state.live = true;
    renderLegend();
    await drawFrame(true);
    syncMenu();
  }

  // ------------------------------------------------------------------
  // Overlays
  // ------------------------------------------------------------------
  const cityMarkers = [];

  function tempColor(t) {
    const [r, g, b] = color(SCALES.temp, t);
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  }

  function updateCityTemps() {
    const on = state.overlays.has("temps") && data.forecast && data.forecast.cities.length;
    if (!on) { cityMarkers.forEach((m) => m.remove()); cityMarkers.length = 0; return; }
    const f = forecastFrame();
    if (!cityMarkers.length) {
      data.forecast.cities.forEach((c) => {
        const el = document.createElement("div");
        el.className = "wx-city";
        el.innerHTML = `<span class="wx-city-name"></span><span class="wx-city-temp"></span>`;
        el.querySelector(".wx-city-name").textContent = c.name;
        cityMarkers.push(new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([c.lon, c.lat]).addTo(gm));
      });
    }
    data.forecast.cities.forEach((c, i) => {
      const t = c.temp[f];
      const el = cityMarkers[i].getElement().querySelector(".wx-city-temp");
      el.textContent = t == null ? "–" : `${Math.round(t)}°`;
      el.style.background = t == null ? "#999" : tempColor(t);
      el.style.color = t != null && (t < -5 || t > 35) ? "#fff" : "#111";
    });
    queueDeclutter();
  }

  // Show only cities on the visible side of the globe whose labels don't overlap.
  let declutterQueued = false;
  function declutter() {
    declutterQueued = false;
    if (!cityMarkers.length) return;
    const c = gm.getCenter();
    const rad = Math.PI / 180;
    const placed = [];
    const canvas = gm.getCanvas();
    const W = canvas.clientWidth, H = canvas.clientHeight;
    data.forecast.cities.forEach((city, i) => {
      const el = cityMarkers[i].getElement();
      const cosAngle = Math.sin(c.lat * rad) * Math.sin(city.lat * rad)
        + Math.cos(c.lat * rad) * Math.cos(city.lat * rad) * Math.cos((city.lon - c.lng) * rad);
      let show = cosAngle > 0.25; // well inside the visible hemisphere
      if (show) {
        const p = gm.project([city.lon, city.lat]);
        const box = [p.x - 38, p.y - 34, p.x + 38, p.y];
        show = p.x > 0 && p.y > 0 && p.x < W && p.y < H
          && !placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        if (show) placed.push(box);
      }
      el.style.visibility = show ? "visible" : "hidden";
    });
  }
  const queueDeclutter = () => { if (!declutterQueued) { declutterQueued = true; requestAnimationFrame(declutter); } };

  function applyOverlays() {
    if (!ready) return;
    const vis = (id, on) => { if (gm.getLayer(id)) gm.setLayoutProperty(id, "visibility", on ? "visible" : "none"); };
    vis("labels", state.overlays.has("labels"));
    vis("borders", state.overlays.has("borders"));
    vis("grid", state.overlays.has("grid"));
    vis("night", state.overlays.has("night"));
    vis("nino-fill", state.overlays.has("nino"));
    vis("nino-line", state.overlays.has("nino"));
    if (state.overlays.has("nino")) {
      (data.enso ? Promise.resolve() : loadEnso()).then(() => gm.getSource("nino").setData(ninoGeoJSON())).catch((e) => status(e.message));
    }
    if (state.overlays.has("temps") || state.overlays.has("windanim")) {
      (data.forecast ? Promise.resolve() : loadForecast()).then(() => { updateCityTemps(); wind.sync(); })
        .catch((e) => status(`Forecast not available: ${e.message}`));
    } else updateCityTemps();
    wind.sync();
    syncMenu();
    writeHash();
  }

  // Wind animation, like earth.nullschool / zoom.earth: thousands of particles carried
  // by the forecast wind, drawn with fading trails on a screen-sized canvas above the
  // globe. Only the visible side is used; trails restart whenever the view moves.
  const wind = (() => {
    let canvas = null, ctx = null, particles = [], raf = 0, on = false, moving = false, dpr = 1;
    let target = 0, last = 0, slow = 0, fast = 0; // adaptive particle count for slower devices
    const rad = Math.PI / 180;
    const MAX_AGE = 110;

    function resize() {
      updateCenter();
      const box = gm.getContainer().getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      target = Math.round(Math.min(5000, (box.width * box.height) / (window.innerWidth < 600 ? 260 : 230)));
      particles = Array.from({ length: target }, () => spawn(true));
    }

    // Globe centre, refreshed once per frame (not per particle).
    let sinC = 0, cosC = 1, lngC = 0;
    const updateCenter = () => { const c = gm.getCenter(); sinC = Math.sin(c.lat * rad); cosC = Math.cos(c.lat * rad); lngC = c.lng; };
    const visible = (lat, lon) => sinC * Math.sin(lat * rad) + cosC * Math.cos(lat * rad) * Math.cos((lon - lngC) * rad) > 0.05;

    // A random point on the visible part of the globe, inside the screen.
    function spawn(randomAge) {
      const W = canvas.width / dpr, H = canvas.height / dpr;
      for (let tries = 0; tries < 12; tries++) {
        const ll = gm.unproject([Math.random() * W, Math.random() * H]);
        const lat = ll.lat, lon = ((ll.lng + 540) % 360) - 180;
        if (Math.abs(lat) < 85 && visible(lat, lon)) {
          const p = gm.project([lon, lat]);
          if (p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H) {
            return { lat, lon, x: p.x, y: p.y, age: randomAge ? Math.floor(Math.random() * MAX_AGE) : 0 };
          }
        }
      }
      return { lat: 0, lon: 0, x: -1, y: -1, age: MAX_AGE }; // respawns next frame
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (moving || !data.forecast) return;
      // Keep the animation smooth: drop particles when frames take too long, add them back when there is room.
      const dt = last ? now - last : 16;
      last = now;
      if (dt > 45) { slow++; fast = 0; } else if (dt < 22) { fast++; slow = 0; }
      if (slow > 8 && particles.length > 600) { particles.length = Math.round(particles.length * 0.75); slow = 0; }
      if (fast > 60 && particles.length < target) {
        for (let i = 0, add = Math.min(300, target - particles.length); i < add; i++) particles.push(spawn(true));
        fast = 0;
      }
      const f = forecastFrame();
      const { u: U, v: V } = uvFields(f);
      updateCenter();
      const W = canvas.width, H = canvas.height;
      // Fade the old trails.
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "rgba(0,0,0,0.93)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = 1.15 * dpr;
      ctx.lineCap = "round";
      // Screen speed: about 1 px per frame for a 20 km/h wind, whatever the zoom.
      const ppd = (512 * Math.pow(2, gm.getZoom())) / 360; // pixels per degree near the centre
      const k = 0.05 / ppd;
      const buckets = [[], [], [], []]; // by speed, so each gets one stroke style
      for (let i = 0; i < particles.length; i++) {
        let p = particles[i];
        if (p.age++ > MAX_AGE) { p = particles[i] = spawn(false); continue; }
        const u = sample(U, p.lat, p.lon), v = sample(V, p.lat, p.lon);
        if (u == null || v == null) { p.age = MAX_AGE + 1; continue; }
        const speed = Math.abs(u) + Math.abs(v) * 0.6; // cheap stand-in for hypot, only used for brightness
        if (speed < 0.5) { p.age = MAX_AGE + 1; continue; }
        const lat2 = p.lat + v * k;
        let lon2 = p.lon + (u * k) / Math.max(0.15, Math.cos(p.lat * rad));
        lon2 = lon2 > 180 ? lon2 - 360 : lon2 < -180 ? lon2 + 360 : lon2;
        if (Math.abs(lat2) > 85 || !visible(lat2, lon2)) { p.age = MAX_AGE + 1; continue; }
        const q = gm.project([lon2, lat2]);
        if (p.x >= 0 && Math.abs(q.x - p.x) < 40 && Math.abs(q.y - p.y) < 40) {
          const b = speed < 15 ? 0 : speed < 35 ? 1 : speed < 60 ? 2 : 3;
          buckets[b].push(p.x * dpr, p.y * dpr, q.x * dpr, q.y * dpr);
        }
        p.lat = lat2; p.lon = lon2; p.x = q.x; p.y = q.y;
      }
      const alpha = [0.45, 0.65, 0.85, 1];
      buckets.forEach((segs, b) => {
        if (!segs.length) return;
        ctx.strokeStyle = `rgba(255,255,255,${alpha[b]})`;
        ctx.beginPath();
        for (let j = 0; j < segs.length; j += 4) { ctx.moveTo(segs[j], segs[j + 1]); ctx.lineTo(segs[j + 2], segs[j + 3]); }
        ctx.stroke();
      });
    }

    const pause = () => { moving = true; if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); };
    const resume = () => {
      moving = false;
      if (!on) return;
      // Re-project every particle for the new view (and re-seed the ones now hidden).
      updateCenter();
      particles = particles.map((p) => {
        if (!visible(p.lat, p.lon)) return spawn(true);
        const q = gm.project([p.lon, p.lat]);
        return { ...p, x: q.x, y: q.y };
      });
    };

    function start() {
      if (on || !ready || !data.forecast) return;
      on = true;
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.className = "wx-wind";
        gm.getCanvas().after(canvas); // above the globe, below city labels and popups
        ctx = canvas.getContext("2d");
        gm.on("movestart", pause);
        gm.on("moveend", resume);
        gm.on("resize", () => { if (on) resize(); });
      }
      canvas.hidden = false;
      resize();
      raf = requestAnimationFrame(frame);
    }

    function stop() {
      if (!on) return;
      on = false;
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.hidden = true;
    }

    return { sync: () => (state.overlays.has("windanim") && data.forecast ? start() : stop()) };
  })();

  // ------------------------------------------------------------------
  // Click: the forecast at that point
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Radar prediction engine (nowcast.js) for a clicked place
  // ------------------------------------------------------------------
  const NC = { zoom: 6, tiles: 3, stepMin: 10, threshold: 0.05 };
  const tileXY = (lon, lat, z) => {
    const n = 2 ** z, r = (lat * Math.PI) / 180;
    return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
  };
  const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

  // Radar intensity grid (0..1) for a block of tiles, from RainViewer's black-and-white (dBZ) images.
  // Rain (0..1) on the 3×3 radar tiles around a place.
  async function radarGrid(path, x0, y0) {
    const size = 256 * NC.tiles;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const n = 2 ** NC.zoom;
    await Promise.all(Array.from({ length: NC.tiles * NC.tiles }, (_, k) => new Promise((resolve) => {
      const i = k % NC.tiles, j = Math.floor(k / NC.tiles);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { ctx.drawImage(img, i * 256, j * 256); resolve(); };
      img.onerror = resolve; // missing tile = no data
      // Colour scheme 2 (the only one served now), no smoothing, snow drawn as rain.
      img.src = `${data.radar.host}${path}/256/${NC.zoom}/${(x0 + i + n) % n}/${y0 + j}/2/0_0.png`;
    })));
    const px = ctx.getImageData(0, 0, size, size).data;
    const g = Nowcast.grid(size, size);
    for (let i = 0; i < size * size; i++) {
      const a = px[i * 4 + 3];
      g.data[i] = Nowcast.intensity(Nowcast.decodeColor(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], a));
    }
    return g;
  }

  // Colours for predicted images (light → heavy rain), close to the radar legend.
  // Rain colours (intensity = (dBZ − 5) / 50): blue → purple → red → orange → yellow,
  // used for the radar itself (recoloured, see the wxradar protocol) and predicted images.
  const RAIN_RAMP = [[0.05, [30, 60, 200, 0.5]], [0.25, [40, 100, 255, 0.85]], [0.4, [90, 80, 245, 0.95]],
    [0.5, [150, 60, 220, 1]], [0.6, [215, 45, 150, 1]], [0.7, [245, 40, 50, 1]], [0.8, [255, 140, 20, 1]],
    [0.9, [255, 220, 0, 1]], [1, [255, 255, 190, 1]]];
  // Redrawing radar tiles runs in two Web Workers (nowcast-worker.js) so the map never
  // stalls. null = workers unavailable.
  const pools = {};
  let callSeq = 0;
  const calls = new Map();
  function workerFor(kind, i = 0) {
    const name = `${kind}${i}`;
    if (pools[name] === undefined) {
      try {
        const w = new Worker(document.querySelector('script[src*="nowcast.js"]').src.replace("nowcast.js", "nowcast-worker.js"));
        w.onmessage = (e) => {
          const call = calls.get(e.data.id);
          calls.delete(e.data.id);
          if (call) (e.data.error ? call.reject(new Error(e.data.error)) : call.resolve(e.data));
        };
        w.onerror = () => { pools[name] = null; };
        pools[name] = w;
      } catch (e) { pools[name] = null; }
    }
    return pools[name];
  }
  function callWorker(w, msg, transfer = []) {
    const id = ++callSeq;
    w.postMessage({ ...msg, id }, transfer);
    return new Promise((resolve, reject) => calls.set(id, { resolve, reject }));
  }
  // Predicted rain (0..1) at a place in each of our predicted images: the pixels are
  // read back from the tiles (same colours as RAIN_RAMP, so they can be inverted).
  let rampLut = null;
  function invertColor(r, g, b, a) {
    if (a < 25) return 0;
    rampLut = rampLut || Array.from({ length: 96 }, (_, i) => { const v = 0.05 + i / 100; return [v, color({ stops: RAIN_RAMP }, v)]; });
    let best = 0, err = Infinity;
    for (const [v, c] of rampLut) {
      const e = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (e < err) { err = e; best = v; }
    }
    return best;
  }
  async function predictedAt(lon, lat, frames) {
    const z = data.nowcast.zoom;
    const t = tileXY(lon, lat, z);
    const tx = Math.floor(t.x), ty = Math.floor(t.y), key = `${z}/${tx}/${ty}`;
    const px = Math.floor((t.x - tx) * 256), py = Math.floor((t.y - ty) * 256);
    return Promise.all(frames.map(async (f) => {
      if (!f.tileSet.has(key)) return 0;
      try {
        const res = await fetch(new URL(`${f.path}/${key}.png`, document.baseURI));
        const bmp = await createImageBitmap(await res.blob());
        const c = document.createElement("canvas");
        c.width = 5; c.height = 5;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, -(px - 2), -(py - 2));
        const d = ctx.getImageData(0, 0, 5, 5).data;
        let v = 0;
        for (let i = 0; i < d.length; i += 4) v = Math.max(v, invertColor(d[i], d[i + 1], d[i + 2], d[i + 3]));
        return v;
      } catch (e) { return 0; }
    }));
  }
  // Motion of the rain near a place, measured on the server (per zoom-5 tile).
  function motionNear(lon, lat) {
    const nc = data.nowcast, z = nc.zoom, t = tileXY(lon, lat, z);
    let best = null;
    for (let r = 0; r <= 2 && !best; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const m = nc.motion[`${Math.floor(t.x) + dx}/${Math.floor(t.y) + dy}`];
        if (m && (!best || m[0] > best[0])) best = m;
      }
    }
    return best && best[0] >= 3 ? { kmh: best[0], towards: compass(best[1]) } : null;
  }

  async function runNowcast(lon, lat) {
    if (!data.radar) await loadRadar();
    if (!data.nowcast) await loadNowcast();
    if (!data.nowcast) throw new Error("the prediction is not ready yet");
    const past = data.radar.radar.past || [];
    const latest = past[past.length - 1];
    const ahead = data.nowcast.frames.filter((f) => f.time > latest.time);
    const t = tileXY(lon, lat, NC.zoom);
    const x0 = Math.floor(t.x) - 1, y0 = Math.max(0, Math.min(2 ** NC.zoom - NC.tiles, Math.floor(t.y) - 1));
    const [gNow, air, future] = await Promise.all([radarGrid(latest.path, x0, y0), airAt(lat, lon), predictedAt(lon, lat, ahead)]);
    const px = (t.x - x0) * 256, py = (t.y - y0) * 256;
    let nowV = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) nowV = Math.max(nowV, Nowcast.sample(gNow, px + i, py + j));
    const timeline = [nowV, ...future];
    const summary = Nowcast.summarize(timeline, NC.threshold);
    const near = Nowcast.nearestRain(gNow, px, py, NC.threshold, 380);
    const kmPerPx = (40075.016686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** NC.zoom);
    // Motion where the nearest rain is (or here).
    const nearLonLat = near ? [((x0 + near.x / 256) / 2 ** NC.zoom) * 360 - 180, tileLat(y0 + near.y / 256, NC.zoom)] : [lon, lat];
    return {
      timeline, summary, motion: motionNear(...nearLonLat), air, measured: true, latest: new Date(latest.time * 1000),
      near: near ? { km: near.distance * kmPerPx, from: compass(Math.atan2(near.x - px, -(near.y - py)) * (180 / Math.PI)) } : null,
    };
  }

  /* Weather around a place from Open-Meteo: the steering wind at 700 hPa (km per 10 min,
   * x east, y south), instability (CAPE), rain chance, temperature and pressure trend. */
  async function airAt(lat, lon) {
    try {
      const q = new URLSearchParams({ latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: "GMT", wind_speed_unit: "kmh",
        current: "temperature_2m,relative_humidity_2m,pressure_msl",
        hourly: "wind_speed_700hPa,wind_direction_700hPa,cape,precipitation_probability,pressure_msl",
        past_hours: "3", forecast_hours: "3" });
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
      if (!res.ok) return null;
      const d = await res.json();
      const h = d.hourly, now = d.current;
      const i = Math.max(0, h.time.findIndex((x) => x >= now.time.slice(0, 13)));
      const pick = (k) => h[k][Math.min(i, h[k].length - 1)];
      const sp = pick("wind_speed_700hPa"), dir = pick("wind_direction_700hPa");
      const rad = (dir * Math.PI) / 180; // direction the wind comes from
      return {
        temp: now.temperature_2m, humidity: now.relative_humidity_2m, pressure: now.pressure_msl,
        pressureTrend: h.pressure_msl[h.pressure_msl.length - 1] - h.pressure_msl[0], // over 6 hours
        cape: Math.max(...h.cape.slice(i, i + 3).filter((x) => x != null), 0),
        rainChance: Math.max(...h.precipitation_probability.slice(i, i + 3).filter((x) => x != null), 0),
        steer: sp == null || dir == null ? null : { kmh: sp, towards: compass(dir + 180),
          u: (-Math.sin(rad) * sp) / 6, v: (Math.cos(rad) * sp) / 6 },
      };
    } catch (e) { return null; }
  }

  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  const strength = (v) => (v < 0.3 ? "light" : v < 0.6 ? "moderate" : "heavy");

  function nowcastHtml(r) {
    const nowMs = Date.now();
    const at = (steps) => new Date(r.latest.getTime() + steps * NC.stepMin * 60e3);
    const inMin = (steps) => Math.max(0, Math.round((at(steps) - nowMs) / 60e3));
    const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const s = r.summary;
    let head;
    if (s.rainingNow) {
      head = s.stopsInSteps == null
        ? `🌧️ <b>Raining now</b> (${strength(r.timeline[0])}), likely for <b>at least the next hour</b>.`
        : `🌧️ <b>Raining now</b> (${strength(r.timeline[0])}). Should stop in <b>about ${inMin(s.stopsInSteps)} min</b> (≈${clock(at(s.stopsInSteps))}).`;
    } else if (s.arrivesInSteps != null) {
      const lasts = s.lastsSteps == null ? "for over an hour" : `for about ${s.lastsSteps * NC.stepMin} min`;
      head = `🌧️ <b>Rain expected in about ${inMin(s.arrivesInSteps)} min</b> (≈${clock(at(s.arrivesInSteps))}), ${strength(s.peak)}, ${lasts}.`;
    } else {
      head = r.near ? `☀️ <b>No rain heading here</b> in the next hour.`
        : `☀️ <b>No rain on radar</b> within about 400 km. <span class="muted">(Some regions have no weather radar; there, use the weather model below.)</span>`;
    }
    const cells = r.timeline.map((v, i) => {
      const c = v < NC.threshold ? "transparent" : `rgb(${color({ stops: RAIN_RAMP }, v).slice(0, 3).map(Math.round).join(",")})`;
      return `<i style="background:${c}" title="${clock(at(i))}"></i>`;
    }).join("");
    const age = Math.round((nowMs - r.latest) / 60e3);
    return `<p class="wx-nc-head">${head}</p>
      ${r.near && !s.rainingNow ? `<p>Nearest rain: <b>${Math.round(r.near.km)} km</b> to the ${r.near.from}.</p>` : ""}
      ${r.motion ? `<p>Rain is moving towards the <b>${r.motion.towards}</b> at about <b>${Math.round(r.motion.kmh)} km/h</b>${r.measured ? " (measured on radar over the past hour)" : " (from the wind 3 km up)"}.</p>` : ""}
      ${airHtml(r.air)}
      <div class="wx-nc-bar" aria-label="Predicted rain for the next hour">${cells}</div>
      <div class="wx-nc-axis"><span>${clock(r.latest)}</span><span>+30 min</span><span>+1 h</span></div>
      <button class="wx-nc-play" type="button">▶ Play predicted radar (next hour)</button>
      <small>Predicted on our server from how rain moved on radar over the past hour (newest radar image ${age} min old, prediction updated every 10 min). Storms can grow, weaken or form, so treat it as a guide for the next hour.</small>`;
  }

  function airHtml(a) {
    if (!a) return "";
    const bits = [];
    if (a.temp != null) bits.push(`${Math.round(a.temp)}°C`);
    if (a.humidity != null) bits.push(`humidity ${Math.round(a.humidity)}%`);
    if (a.pressure != null) {
      const tr = a.pressureTrend <= -2 ? ", falling" : a.pressureTrend >= 2 ? ", rising" : "";
      bits.push(`pressure ${Math.round(a.pressure)} hPa${tr}`);
    }
    let note = "";
    if (a.cape >= 1000 && a.rainChance >= 30) note = " ⚡ The air is unstable: new showers or thunderstorms can form that radar cannot see yet.";
    else if (a.rainChance >= 50) note = ` The weather model gives a ${Math.round(a.rainChance)}% chance of rain in the next hours.`;
    return `<p class="wx-nc-air">${bits.join(" · ")}.${note}</p>`;
  }

  // ------------------------------------------------------------------
  // Ground check: weather station reports (METAR) near a place
  // ------------------------------------------------------------------
  let stationsP = null;
  function loadStations() {
    stationsP = stationsP || getJson("stations.json", "/api/stations").catch((e) => { stationsP = null; throw e; });
    return stationsP;
  }
  function distKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, a = Math.sin(((lat2 - lat1) * r) / 2) ** 2
      + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }
  // Present weather from the report: rain, drizzle, snow, thunderstorm (− light, + heavy).
  function wxOf(code) {
    const c = code || "";
    const amt = c.includes("+") ? "heavy " : c.includes("-") ? "light " : "";
    if (/TS/.test(c)) return { wet: true, text: `⛈️ ${amt}thunderstorm` };
    if (/SN|SG|PL/.test(c)) return { wet: true, text: `🌨️ ${amt}snow` };
    if (/RA|SH|UP/.test(c)) return { wet: true, text: `🌧️ ${amt}rain` };
    if (/DZ/.test(c)) return { wet: true, text: `🌦️ ${amt}drizzle` };
    return { wet: false, text: "no rain" };
  }
  // Stations within 80 km with a report from the last 2 hours, nearest first.
  function stationsNear(st, lat, lon, maxKm = 80, count = 3) {
    const nowMin = Date.now() / 60e3;
    return ((st && st.stations) || []).map(([id, la, lo, obs]) => ({ id, lat: la, lon: lo, obs, km: distKm(lat, lon, la, lo) }))
      .filter((s) => s.km <= maxKm && nowMin - s.obs[s.obs.length - 1][0] <= 120)
      .sort((a, b) => a.km - b.km).slice(0, count)
      .map((s) => {
        const [minute, temp, code] = s.obs[s.obs.length - 1];
        // Temperature change over about the last hour (the report 45–90 min earlier).
        const before = s.obs.filter((o) => o[0] <= minute - 45 && o[0] >= minute - 90 && o[1] != null).pop();
        return { ...s, time: new Date(minute * 60e3), temp, wx: wxOf(code),
          drop: before && temp != null ? temp - before[1] : null, dir: compass((Math.atan2(s.lon - lon, s.lat - lat) * 180) / Math.PI) };
      });
  }
  function stationsHtml(list, r) {
    if (!list.length) return "";
    const rows = list.map((s) => {
      const dt = s.drop == null || Math.abs(s.drop) < 1 ? "" : ` (${s.drop > 0 ? "+" : "−"}${Math.abs(s.drop).toFixed(0)}° in 1 h)`;
      return `<li><b>${s.id}</b> ${Math.round(s.km)} km ${s.dir} · ${fmtClock(s.time)} · ${s.wx.text}${s.temp != null ? ` · ${Math.round(s.temp)}°C${dt}` : ""}</li>`;
    }).join("");
    const radarWet = r && (r.summary.rainingNow || (r.near && r.near.km < 30));
    const wet = list.filter((s) => s.wx.wet && s.km <= 50);
    const cold = list.find((s) => s.drop != null && s.drop <= -3);
    let verdict = "";
    if (wet.length && radarWet) verdict = `✅ Stations confirm the rain (${wet.map((s) => s.id).join(", ")}).`;
    else if (wet.length && r) verdict = `⚠️ ${wet[0].id} reports ${wet[0].wx.text.replace(/^\S+ /, "")} that the radar does not show here (radar can be late, blocked or missing).`;
    else if (!wet.length && r && r.summary.rainingNow) verdict = "Nearby stations report no rain yet; radar may see rain aloft or the shower is very local.";
    if (cold) verdict += ` 🌡️ Temperature fell ${Math.abs(cold.drop).toFixed(0)}°C in an hour at ${cold.id}: cool air from rain or a storm${radarWet ? "" : ", which often arrives just before it"}.`;
    return `<p class="wx-st-head">📍 Ground check: weather stations</p><ul class="wx-st-list">${rows}</ul>${verdict ? `<p>${verdict}</p>` : ""}`;
  }

  // Village / town name for a point (OpenStreetMap Nominatim; one request per click).
  async function placeName(lat, lon) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
      if (!res.ok) return null;
      const d = await res.json();
      const a = d.address || {};
      const name = a.village || a.hamlet || a.town || a.city || a.suburb || a.municipality || a.county || d.name;
      const area = [a.state_district || a.county, a.state, a.country].filter((x) => x && x !== name);
      return name ? { name, area: area.slice(0, 2).join(", ") } : null;
    } catch (e) { return null; }
  }

  let popup = null, pin = null;
  let clickSeq = 0;
  function closeInfo() {
    if (popup) { popup.remove(); popup = null; }
    if (pin) { pin.remove(); pin = null; }
    const panel = document.querySelector(".wx-info");
    if (panel) panel.remove();
  }
  function showPointInfo(lngLat) {
    const seq = ++clickSeq;
    const { lat } = lngLat;
    const lon = ((lngLat.lng + 540) % 360) - 180;
    closeInfo();
    const body = `<div class="wx-pop">
        <b class="wx-place">${lat.toFixed(3)}°, ${lon.toFixed(3)}°</b><small class="wx-place-area"></small>
        <div class="wx-nc"><p class="muted">📡 Checking the radar for rain heading here…</p></div>
        <div class="wx-st"></div>
        <div class="wx-fc"></div></div>`;
    let el;
    {
      // A card (lower right; above the time bar on phones) and a pin on the map.
      el = document.createElement("div");
      el.className = "wx-info";
      el.innerHTML = `<button class="wx-info-close" aria-label="Close">✕</button>${body}`;
      document.body.appendChild(el);
      el.querySelector(".wx-info-close").addEventListener("click", closeInfo);
      const dot = document.createElement("div");
      dot.className = "wx-pin";
      pin = new maplibregl.Marker({ element: dot }).setLngLat(lngLat).addTo(gm);
    }
    const live = () => seq === clickSeq && el.isConnected;

    placeName(lat, lon).then((p) => {
      if (!p || !live()) return;
      el.querySelector(".wx-place").textContent = p.name;
      el.querySelector(".wx-place-area").textContent = p.area;
    });

    const ncP = runNowcast(lon, lat);
    Promise.all([ncP.catch(() => null), loadStations()]).then(([r, st]) => {
      if (live()) el.querySelector(".wx-st").innerHTML = stationsHtml(stationsNear(st, lat, lon), r);
    }).catch(() => {});
    ncP.then((r) => {
      if (!live()) return;
      el.querySelector(".wx-nc").innerHTML = nowcastHtml(r);
      const btn = el.querySelector(".wx-nc-play");
      if (btn) btn.addEventListener("click", async () => {
        if (state.map !== "radar") { state.map = "radar"; writeHash(); syncMenu(); renderLegend(); await drawFrame(true); }
        renderTimeBar();
        goTo(radarLiveIndex());
        setPlaying(true);
      });
      if (state.map === "radar") renderTimeBar();
    }).catch((err) => {
      if (live()) el.querySelector(".wx-nc").innerHTML = `<p class="muted">📡 Radar prediction not available: ${err.message}</p>`;
    });

    // 5-day forecast for the place (Open-Meteo, in the place's own time zone).
    dailyAt(lat, lon).then((d) => {
      if (!live() || !d) return;
      const dayName = (t, i) => (i === 0 ? "Today" : new Date(`${t}T12:00`).toLocaleDateString(undefined, { weekday: "short" }));
      const rows = d.time.map((t, i) => `<tr><td>${dayName(t, i)}</td><td class="ic">${wxIcon(d.weather_code[i])}</td>
        <td class="lo">${Math.round(d.temperature_2m_min[i])}°</td>
        <td class="bar"><i style="margin-left:${barPos(d, d.temperature_2m_min[i])}%;width:${Math.max(4, barPos(d, d.temperature_2m_max[i]) - barPos(d, d.temperature_2m_min[i]))}%"></i></td>
        <td class="hi">${Math.round(d.temperature_2m_max[i])}°</td>
        <td class="pp">${d.precipitation_probability_max[i] >= 20 ? `💧${d.precipitation_probability_max[i]}%` : ""}</td></tr>`).join("");
      el.querySelector(".wx-fc").innerHTML = `<small>Next 5 days · ${d.tz}</small><table class="wx-days">${rows}</table>`;
    });
  }

  async function dailyAt(lat, lon) {
    try {
      const q = new URLSearchParams({ latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: "auto", forecast_days: "5",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" });
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
      if (!res.ok) return null;
      const j = await res.json();
      const off = j.utc_offset_seconds / 3600;
      const tz = `UTC${off >= 0 ? "+" : "−"}${Math.floor(Math.abs(off))}${Math.abs(off) % 1 ? `:${pad(Math.round((Math.abs(off) % 1) * 60))}` : ""}`;
      return { ...j.daily, tz };
    } catch (e) { return null; }
  }
  // Position (0–100 %) of a temperature on the week's range, for the min–max bar.
  function barPos(d, t) {
    const lo = Math.min(...d.temperature_2m_min), hi = Math.max(...d.temperature_2m_max);
    return hi > lo ? ((t - lo) / (hi - lo)) * 100 : 50;
  }
  function wxIcon(code) {
    if (code === 0) return "☀️";
    if (code <= 2) return "🌤️";
    if (code === 3) return "☁️";
    if (code === 45 || code === 48) return "🌫️";
    if (code >= 95) return "⛈️";
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "🌨️";
    if (code >= 51 && code <= 57) return "🌦️";
    return "🌧️";
  }

  // ------------------------------------------------------------------
  // Place search (OpenStreetMap Nominatim)
  // ------------------------------------------------------------------
  const searchBox = $("wx-search");
  const results = $("wx-results");
  async function searchPlaces(q) {
    results.innerHTML = '<li class="muted">Searching…</li>';
    results.hidden = false;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
      const list = res.ok ? await res.json() : [];
      if (!list.length) { results.innerHTML = '<li class="muted">No places found</li>'; return; }
      results.innerHTML = list.map((p, i) => `<li><button type="button" data-i="${i}">${
        String(p.display_name).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</button></li>`).join("");
      results.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        const p = list[Number(b.dataset.i)];
        results.hidden = true;
        searchBox.blur();
        const center = [Number(p.lon), Number(p.lat)];
        gm.flyTo({ center, zoom: Math.max(gm.getZoom(), 11), speed: 1.6 });
        gm.once("moveend", () => showPointInfo({ lng: center[0], lat: center[1] }));
      }));
    } catch (e) {
      results.innerHTML = '<li class="muted">Search is not available right now</li>';
    }
  }
  $("wx-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = searchBox.value.trim();
    if (q.length >= 2) searchPlaces(q);
  });
  searchBox.addEventListener("input", () => { if (!searchBox.value) results.hidden = true; });
  document.addEventListener("click", (e) => { if (!e.target.closest(".wx-searchbox")) results.hidden = true; });

  // ------------------------------------------------------------------
  // Legend and time bar
  // ------------------------------------------------------------------
  function renderLegend() {
    const el = $("wx-legend");
    const m = state.map;
    if (SCALES[m]) {
      const s = SCALES[m];
      const lo = s.stops[0][0], hi = s.stops[s.stops.length - 1][0];
      const grad = s.stops.map(([v, c]) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(c[3], 0.15)}) ${((v - lo) / (hi - lo)) * 100}%`).join(",");
      const pos = (v) => (v - lo) / (hi - lo);
      const ticks = [];
      s.stops.forEach((st) => { if (!ticks.length || pos(st[0]) - pos(ticks[ticks.length - 1][0]) >= 0.14) ticks.push(st); });
      el.innerHTML = `<div class="wx-leg-title">${MAP_NAMES[m]} <small>${s.unit}</small></div>
        <div class="wx-leg-bar" style="background:linear-gradient(to right,${grad})"></div>
        <div class="wx-leg-ticks">${ticks.map(([v]) => `<span style="left:${((v - lo) / (hi - lo)) * 100}%">${v}</span>`).join("")}</div>`;
      el.hidden = false;
    } else if (m === "sst") {
      el.innerHTML = `<div class="wx-leg-title">Sea temperature vs normal <small>°C</small></div>
        <div class="wx-leg-bar sst-gradient"></div>
        <div class="wx-leg-ticks">${[-3, -2, -1, 0, 1, 2, 3].map((v) => `<span style="left:${((v + 3) / 6) * 100}%">${v > 0 ? "+" : ""}${v}</span>`).join("")}</div>`;
      el.hidden = false;
    } else if (m === "radar") {
      el.innerHTML = `<div class="wx-leg-title">Radar <small>light → heavy rain</small></div>
        <div class="wx-leg-bar" style="background:linear-gradient(to right,${RAIN_RAMP.map(([, c]) => `rgb(${c.slice(0, 3).join(",")})`).join(",")})"></div>`;
      el.hidden = false;
    } else el.hidden = true;
  }

  function relTime(t) {
    const mins = Math.round((t - Date.now()) / 60e3);
    const a = Math.abs(mins);
    if (a === 0) return "just now";
    const text = a < 60 ? `${a} min` : a < 600 && a % 60 ? `${Math.floor(a / 60)} h ${a % 60} min` : `${Math.round(a / 60)} h`;
    return mins <= 0 ? `${text} ago` : `in ${text}`;
  }

  function renderTimeBar() {
    const list = frames();
    const t = list[state.frame];
    const slider = $("wx-slider");
    slider.max = String(Math.max(0, list.length - 1));
    slider.value = String(state.frame);
    slider.disabled = list.length < 2;
    $("wx-play").disabled = list.length < 2;
    $("wx-prev").disabled = state.frame <= 0;
    $("wx-next").disabled = state.frame >= list.length - 1;
    const isLive = !FORECAST_MAPS.includes(state.map) && state.map !== "sst" && state.frame === liveIndex(list);
    $("wx-live").classList.toggle("on", isLive);
    $("wx-live").textContent = FORECAST_MAPS.includes(state.map) ? "Now" : "Live";
    $("wx-live").hidden = state.map === "sst";
    if (!t) { $("wx-when").textContent = "…"; $("wx-when-sub").textContent = ""; return; }
    $("wx-when").textContent = state.map === "sst"
      ? t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
      : `${t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
    const rf = state.map === "radar" ? radarFrames()[state.frame] || {} : {};
    const what = FORECAST_MAPS.includes(state.map) ? "Forecast" : state.map === "sst" ? "Daily map"
      : rf.predicted ? (rf.time <= Date.now() / 1000 + 150 ? `Radar estimate for now (newest image ${Math.round((Date.now() / 1000 - radarFrames()[radarLiveIndex()].time) / 60)} min old)` : "Predicted radar") : rf.nowcast ? "Radar forecast" : isLive ? (state.map === "radar" ? "Live radar" : "Latest image") : "Replay";
    $("wx-when-sub").textContent = state.map === "sst" ? what : `${what} · ${relTime(t)}`;
    renderRange(list);
  }

  // How much time the loop covers, e.g. "Radar loop: 2 h · every 10 min · 13 images".
  const fmtClock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function span(mins) {
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  function renderRange(list) {
    const el = $("wx-range");
    if (list.length < 2) { el.innerHTML = ""; return; }
    const first = list[0], lastT = list[list.length - 1];
    const step = Math.round((list[1] - list[0]) / 60e3);
    const sameDay = first.toDateString() === lastT.toDateString();
    const day = (d) => (sameDay ? "" : `${d.toLocaleDateString(undefined, { weekday: "short" })} `);
    let label;
    if (state.map === "radar") {
      const live = radarLiveIndex();
      const pastMins = Math.round((list[live] - first) / 60e3);
      const ahead = list.length - 1 - live;
      const checked = data.radarCheckedAt ? ` · checked ${relTime(data.radarCheckedAt)}` : "";
      label = `Radar loop: ${span(pastMins)} · every ${step} min · ${live + 1} images`
        + (ahead ? ` + ${span(Math.round((lastT - list[live]) / 60e3))} ${radarFrames()[live + 1].predicted ? "predicted" : "forecast"}` : "") + checked;
    } else if (state.map === "satellite") {
      label = `Satellite loop: ${span(Math.round((lastT - first) / 60e3))} · every ${span(step)} · ${list.length} images · updates every 10 min`;
    } else {
      label = `Forecast: ${span(Math.round((lastT - first) / 60e3))} ahead · every ${span(step)}`;
    }
    el.innerHTML = `<span>${day(first)}${fmtClock(first)}</span><b>${label}</b><span>${day(lastT)}${fmtClock(lastT)}</span>`;
  }

  function goTo(i) {
    const list = frames();
    state.frame = Math.max(0, Math.min(list.length - 1, i));
    state.live = !FORECAST_MAPS.includes(state.map) && state.frame === liveIndex(list);
    drawFrame();
  }

  let playTimer = 0;
  function setPlaying(on) {
    state.playing = on;
    $("wx-play").textContent = on ? "❚❚" : "▶";
    $("wx-play").setAttribute("aria-label", on ? "Pause" : "Play");
    clearTimeout(playTimer);
    if (!on) return;
    const tick = () => {
      if (!state.playing) return;
      const n = frames().length;
      goTo(state.frame >= n - 1 ? 0 : state.frame + 1);
      // Wait for the tiles of satellite/radar frames, but never longer than 2.5 s.
      // Radar and forecast frames are preloaded: a steady pace.
      const preloaded = FORECAST_MAPS.includes(state.map) || state.map === "radar";
      const delay = state.map === "radar" ? 500 : preloaded ? 600 : 900;
      let waited = false;
      const next = () => { if (!waited) { waited = true; playTimer = setTimeout(tick, delay); } };
      if (preloaded) next();
      else { gm.once("idle", next); setTimeout(next, 2500); }
    };
    tick();
  }

  // ------------------------------------------------------------------
  // Menus, links (#map=wind&ov=temps,labels) and refresh
  // ------------------------------------------------------------------
  function syncMenu() {
    document.querySelectorAll("[data-map]").forEach((b) => b.classList.toggle("on", b.dataset.map === state.map));
    document.querySelectorAll("[data-style]").forEach((b) => b.classList.toggle("on", b.dataset.style === state.style));
    $("wx-sat-styles").hidden = state.map !== "satellite";
    $("wx-radar-opts").hidden = state.map !== "radar";
    $("wx-rv-clouds").classList.toggle("on", state.rvClouds);
    document.querySelectorAll("[data-overlay]").forEach((b) => {
      b.classList.toggle("on", state.overlays.has(b.dataset.overlay));
      b.setAttribute("aria-pressed", String(state.overlays.has(b.dataset.overlay)));
    });
    $("wx-map-name").textContent = MAP_NAMES[state.map];
  }

  function writeHash() {
    const p = new URLSearchParams({ map: state.map, ov: [...state.overlays].join(",") });
    if (state.map === "satellite") p.set("style", state.style);
    if (state.map === "radar" && !state.rvClouds) p.set("clouds", "0");
    history.replaceState(null, "", `#${p}`);
  }

  function readHash() {
    const p = new URLSearchParams(window.location.hash.slice(1));
    if (MAP_NAMES[p.get("map")]) state.map = p.get("map");
    if (["truecolor", "infrared"].includes(p.get("style"))) state.style = p.get("style");
    if (p.get("clouds") === "0") state.rvClouds = false;
    if (p.has("ov")) state.overlays = new Set(p.get("ov").split(",").filter(Boolean));
  }

  document.querySelectorAll("[data-map]").forEach((b) => b.addEventListener("click", () => {
    setPlaying(false);
    state.map = b.dataset.map;
    if (state.map === "wind" && !state.overlays.has("windanim")) { state.overlays.add("windanim"); applyOverlays(); }
    writeHash();
    showMap();
    if (window.innerWidth < 900) closePanels();
  }));
  $("wx-rv-clouds").addEventListener("click", () => {
    state.rvClouds = !state.rvClouds;
    writeHash();
    syncMenu();
    drawFrame(true);
  });
  document.querySelectorAll("[data-style]").forEach((b) => b.addEventListener("click", () => {
    state.style = b.dataset.style;
    writeHash();
    syncMenu();
    drawFrame(true);
  }));
  document.querySelectorAll("[data-overlay]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.overlay;
    if (state.overlays.has(id)) state.overlays.delete(id); else state.overlays.add(id);
    applyOverlays();
  }));
  document.querySelectorAll("[data-collapse]").forEach((b) => b.addEventListener("click", () => {
    const panel = $(b.dataset.collapse);
    const collapsed = panel.classList.toggle("collapsed");
    b.setAttribute("aria-expanded", String(!collapsed));
    if (window.innerWidth < 900) panel.classList.remove("open", "collapsed");
  }));
  function closePanels() { document.querySelectorAll(".wx-panel").forEach((p) => p.classList.remove("open")); }
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const panel = $(b.dataset.open);
    const open = !panel.classList.contains("open");
    closePanels();
    panel.classList.toggle("open", open);
  }));
  document.addEventListener("click", (e) => {
    if (window.innerWidth < 900 && !e.target.closest(".wx-panel")) closePanels();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePanels(); closeInfo(); }
    if (e.target.tagName === "INPUT") return;
    if (e.key === "ArrowLeft") goTo(state.frame - 1);
    if (e.key === "ArrowRight") goTo(state.frame + 1);
    if (e.key === " ") { e.preventDefault(); setPlaying(!state.playing); }
  });
  $("wx-prev").addEventListener("click", () => { setPlaying(false); goTo(state.frame - 1); });
  $("wx-next").addEventListener("click", () => { setPlaying(false); goTo(state.frame + 1); });
  $("wx-play").addEventListener("click", () => setPlaying(!state.playing));
  $("wx-live").addEventListener("click", () => { setPlaying(false); goTo(defaultFrame(frames())); });
  let slideTimer = 0;
  $("wx-slider").addEventListener("input", (e) => {
    setPlaying(false);
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => goTo(Number(e.target.value)), 120);
  });

  // Every 5 minutes: newest satellite slot, new radar frames, night line, newer forecast.
  setInterval(async () => {
    if (!ready || state.playing) return;
    try {
      if (data.forecast && Date.now() - new Date(data.forecast.built_at) > 3 * 3600e3) {
        await loadForecast();
        imageCache.clear();
      }
    } catch (e) { /* keep showing what we have */ }
    if (state.map === "radar") return; // handled by refreshRadar()
    if (state.live) state.frame = liveIndex(frames());
    drawFrame();
  }, REFRESH_MS);

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  readHash();
  syncMenu();
  if (window.innerWidth < 900) document.querySelectorAll(".wx-panel").forEach((p) => p.classList.remove("open"));
  loadMapLibre().then(createGlobe).catch((err) => status(err.message, 0));
  if (state.overlays.has("temps") || state.overlays.has("windanim") || FORECAST_MAPS.includes(state.map)) {
    loadForecast().then(() => { updateCityTemps(); wind.sync(); if (FORECAST_MAPS.includes(state.map)) showMap(); }).catch(() => {});
  }
})();
