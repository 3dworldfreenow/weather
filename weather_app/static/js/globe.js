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
  const REFRESH_MS = 5 * 60e3;       // check for new images every 5 minutes
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

  const state = { map: "satellite", style: "truecolor", overlays: new Set(["temps", "labels", "borders", "night"]),
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
    const res = await fetch(RAINVIEWER);
    if (!res.ok) throw new Error(`Radar not available (${res.status})`);
    data.radar = await res.json();
    return data.radar;
  }

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
    if (state.map === "radar") {
      const past = (data.radar && data.radar.radar && data.radar.radar.past) || [];
      return past.map((f) => new Date(f.time * 1000));
    }
    if (state.map === "sst") return data.enso ? [new Date(`${data.enso.sst_layer.date}T12:00:00Z`)] : [];
    return data.forecast ? data.forecast.times.map((t) => new Date(t)) : [];
  }

  function defaultFrame(list) {
    if (!FORECAST_MAPS.includes(state.map)) return Math.max(0, list.length - 1);
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

  function windAt(f, lat, lon) {
    const fields = data.forecast.fields;
    const speed = sample(fields.wind[f], lat, lon);
    // Direction is where the wind comes FROM; interpolate as a vector to avoid the 359°→0° jump.
    const g = data.forecast.grid;
    const dirField = fields.wind_dir[f];
    const r = Math.round((lat - g.lat0) / g.dlat);
    const c = ((Math.round((lon - g.lon0) / g.dlon) % g.nlon) + g.nlon) % g.nlon;
    const dir = dirField[Math.max(0, Math.min(g.nlat - 1, r)) * g.nlon + c];
    if (speed == null || dir == null) return null;
    const rad = (dir * Math.PI) / 180;
    return { speed, u: -speed * Math.sin(rad), v: -speed * Math.cos(rad), dir };
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
    gm = new maplibregl.Map({
      container: "wx-globe",
      center: startCenter ? startCenter.center : [78, 20],
      zoom: startCenter ? startCenter.zoom : (window.innerWidth < 600 ? 1.4 : 2.2),
      maxZoom: 10,
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
            paint: { "line-color": "rgba(255,255,255,0.35)", "line-width": ["case", ["get", "equator"], 1.4, 0.6] } },
          { id: "nino-fill", type: "fill", source: "nino",
            paint: { "fill-color": ["case", ["get", "warm"], "#ff5a3c", ["get", "cool"], "#4d8dff", "#ffffff"], "fill-opacity": 0.12 } },
          { id: "nino-line", type: "line", source: "nino",
            paint: { "line-color": ["case", ["get", "warm"], "#ff5a3c", ["get", "cool"], "#4d8dff", "#ffffff"], "line-width": 2 } },
          { id: "anchor-wind", type: "background", layout: { visibility: "none" } },
          { id: "labels", type: "raster", source: "labels" },
        ],
      },
    });
    gm.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    gm.addControl(new maplibregl.AttributionControl({ compact: true,
      customAttribution: "Satellites: NASA GIBS, EUMETSAT · Radar: RainViewer · Forecast: Open-Meteo" }), "bottom-right");
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

  function addRaster(id, source, opacity = 1) {
    gm.addSource(id, source);
    gm.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } }, "anchor-map");
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

  function radarTiles(i) {
    const f = data.radar.radar.past[i];
    return [`${data.radar.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`];
  }

  // Draw the current frame; when only the time changed, swap tiles in place.
  async function drawFrame(rebuild = false) {
    if (!ready) return;
    const time = currentTime();
    const m = state.map;
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
        if (rebuild || !gm.getSource("radar")) {
          clearMapLayers();
          addRaster("radar", { type: "raster", tiles: radarTiles(state.frame), tileSize: 256, maxzoom: 7,
            attribution: '<a href="https://www.rainviewer.com/">RainViewer</a>' }, 0.85);
        } else gm.getSource("radar").setTiles(radarTiles(state.frame));
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

  // Wind animation: particles moved by the forecast wind, drawn on a canvas that the
  // globe shows as an animated image (Web Mercator coordinates).
  const wind = (() => {
    const W = 1024, H = 1024, N = window.innerWidth < 600 ? 1800 : 3500;
    let canvas = null, ctx = null, particles = [], raf = 0, on = false;
    const toX = (lon) => ((lon + 180) / 360) * W;
    const toY = (lat) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * H;
    const spawn = () => ({ lon: Math.random() * 360 - 180, lat: Math.asin(Math.random() * 2 - 1) * 57.2958 * 0.94, age: Math.random() * 80 });

    function step() {
      const f = forecastFrame();
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "rgba(0,0,0,0.92)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (const p of particles) {
        const w = windAt(f, p.lat, p.lon);
        p.age += 1;
        if (!w || p.age > 90 || Math.abs(p.lat) > 82) { Object.assign(p, spawn(), { age: 0 }); continue; }
        const k = 0.0022;
        const lon2 = p.lon + (w.u * k) / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
        const lat2 = p.lat + w.v * k;
        const x1 = toX(p.lon), y1 = toY(p.lat), x2 = toX(lon2), y2 = toY(lat2);
        if (Math.abs(x2 - x1) < W / 2) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
        p.lon = lon2 > 180 ? lon2 - 360 : lon2 < -180 ? lon2 + 360 : lon2;
        p.lat = lat2;
      }
      ctx.stroke();
      raf = requestAnimationFrame(step);
    }

    function start() {
      if (on || !ready || !data.forecast) return;
      on = true;
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        ctx = canvas.getContext("2d");
      }
      particles = Array.from({ length: N }, spawn);
      gm.addSource("wind-anim", { type: "canvas", canvas, coordinates: MERC_CORNERS, animate: true });
      gm.addLayer({ id: "wind-anim", type: "raster", source: "wind-anim", paint: { "raster-fade-duration": 0 } }, "anchor-wind");
      raf = requestAnimationFrame(step);
    }

    function stop() {
      if (!on) return;
      on = false;
      cancelAnimationFrame(raf);
      if (gm.getLayer("wind-anim")) gm.removeLayer("wind-anim");
      if (gm.getSource("wind-anim")) gm.removeSource("wind-anim");
      ctx.clearRect(0, 0, W, H);
    }

    return { sync: () => (state.overlays.has("windanim") && data.forecast ? start() : stop()) };
  })();

  // ------------------------------------------------------------------
  // Click: the forecast at that point
  // ------------------------------------------------------------------
  let popup = null;
  function showPointInfo(lngLat) {
    if (!data.forecast) { loadForecast().then(() => showPointInfo(lngLat)).catch(() => {}); return; }
    const f = forecastFrame();
    const { lat } = lngLat;
    const lon = ((lngLat.lng + 540) % 360) - 180;
    const F = data.forecast.fields;
    const v = (k) => sample(F[k][f], lat, lon);
    const w = windAt(f, lat, lon);
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const fmt = (x, d = 0) => (x == null ? "–" : x.toFixed(d));
    const time = new Date(data.forecast.times[f]);
    const html = `<div class="wx-pop">
      <b>${lat.toFixed(2)}°, ${lon.toFixed(2)}°</b>
      <small>Forecast for ${time.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</small>
      <ul>
        <li>🌡️ ${fmt(v("temp"))} °C</li>
        <li>🌧️ ${fmt(v("rain"), 1)} mm / 3 h</li>
        <li>💨 ${w ? `${Math.round(w.speed)} km/h from ${dirs[Math.round(w.dir / 45) % 8]}` : "–"}</li>
        <li>💧 ${fmt(v("humidity"))} %</li>
        <li>🧭 ${fmt(v("pressure"))} hPa</li>
      </ul>
      <small class="muted">Coarse global model grid (Open-Meteo)</small></div>`;
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: "240px" }).setLngLat(lngLat).setHTML(html).addTo(gm);
  }

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
        <div class="wx-leg-bar" style="background:linear-gradient(to right,#88ddee,#0099cc,#0077aa,#005588,#ffee00,#ffaa00,#ff4400,#c10000)"></div>`;
      el.hidden = false;
    } else el.hidden = true;
  }

  function relTime(t) {
    const mins = Math.round((t - Date.now()) / 60e3);
    const a = Math.abs(mins);
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
    const isLive = !FORECAST_MAPS.includes(state.map) && state.frame === list.length - 1;
    $("wx-live").classList.toggle("on", isLive);
    $("wx-live").textContent = FORECAST_MAPS.includes(state.map) ? "Now" : "Live";
    $("wx-live").hidden = state.map === "sst";
    if (!t) { $("wx-when").textContent = "…"; $("wx-when-sub").textContent = ""; return; }
    $("wx-when").textContent = state.map === "sst"
      ? t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
      : `${t.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
    const what = FORECAST_MAPS.includes(state.map) ? "Forecast" : state.map === "sst" ? "Daily map" : isLive ? "Latest image" : "Replay";
    $("wx-when-sub").textContent = state.map === "sst" ? what : `${what} · ${relTime(t)}`;
  }

  function goTo(i) {
    const list = frames();
    state.frame = Math.max(0, Math.min(list.length - 1, i));
    state.live = !FORECAST_MAPS.includes(state.map) && state.frame === list.length - 1;
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
      const delay = FORECAST_MAPS.includes(state.map) ? 600 : 900;
      let waited = false;
      const next = () => { if (!waited) { waited = true; playTimer = setTimeout(tick, delay); } };
      if (FORECAST_MAPS.includes(state.map)) next();
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
    document.querySelectorAll("[data-overlay]").forEach((b) => {
      b.classList.toggle("on", state.overlays.has(b.dataset.overlay));
      b.setAttribute("aria-pressed", String(state.overlays.has(b.dataset.overlay)));
    });
    $("wx-map-name").textContent = MAP_NAMES[state.map];
  }

  function writeHash() {
    const p = new URLSearchParams({ map: state.map, ov: [...state.overlays].join(",") });
    if (state.map === "satellite") p.set("style", state.style);
    history.replaceState(null, "", `#${p}`);
  }

  function readHash() {
    const p = new URLSearchParams(window.location.hash.slice(1));
    if (MAP_NAMES[p.get("map")]) state.map = p.get("map");
    if (["truecolor", "infrared"].includes(p.get("style"))) state.style = p.get("style");
    if (p.has("ov")) state.overlays = new Set(p.get("ov").split(",").filter(Boolean));
  }

  document.querySelectorAll("[data-map]").forEach((b) => b.addEventListener("click", () => {
    setPlaying(false);
    state.map = b.dataset.map;
    writeHash();
    showMap();
    if (window.innerWidth < 900) closePanels();
  }));
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
    if (e.key === "Escape") closePanels();
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
      if (state.map === "radar") await loadRadar();
      if (data.forecast && Date.now() - new Date(data.forecast.built_at) > 3 * 3600e3) {
        await loadForecast();
        imageCache.clear();
      }
    } catch (e) { /* keep showing what we have */ }
    if (state.live) state.frame = Math.max(0, frames().length - 1);
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
