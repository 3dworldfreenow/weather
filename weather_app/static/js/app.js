/* Weather Map front-end: Leaflet map, layers, timeline, wind particles, forecast panel. */
(() => {
  "use strict";

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  let loadingCount = 0;
  function setLoading(on) {
    loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
    $("loading").hidden = loadingCount === 0;
  }

  let toastTimer;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  async function api(path, params = {}, { signal } = {}) {
    const url = new URL(path, window.location.origin);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    setLoading(true);
    try {
      const res = await fetch(url, { signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      return body;
    } finally {
      setLoading(false);
    }
  }

  // ------------------------------------------------------------------
  // Units
  // ------------------------------------------------------------------
  const state = {
    units: "metric",
    layer: "satellite",
    showEvents: true,
  };
  try { state.units = localStorage.getItem("units") || "metric"; } catch (e) { /* ignore */ }

  const imperial = () => state.units === "imperial";
  const fmtTemp = (c) => (c == null ? "–" : `${Math.round(imperial() ? c * 9 / 5 + 32 : c)}°`);
  const fmtWind = (kmh) => (kmh == null ? "–" : imperial() ? `${Math.round(kmh / 1.609)} mph` : `${Math.round(kmh)} km/h`);
  const fmtPrecip = (mm) => (mm == null ? "–" : imperial() ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`);
  const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

  // WMO weather interpretation codes.
  const WMO = {
    0: ["Clear sky", "☀️", "🌙"], 1: ["Mainly clear", "🌤️", "🌙"], 2: ["Partly cloudy", "⛅", "☁️"],
    3: ["Overcast", "☁️", "☁️"], 45: ["Fog", "🌫️", "🌫️"], 48: ["Rime fog", "🌫️", "🌫️"],
    51: ["Light drizzle", "🌦️", "🌧️"], 53: ["Drizzle", "🌦️", "🌧️"], 55: ["Heavy drizzle", "🌧️", "🌧️"],
    56: ["Freezing drizzle", "🌧️", "🌧️"], 57: ["Freezing drizzle", "🌧️", "🌧️"],
    61: ["Light rain", "🌦️", "🌧️"], 63: ["Rain", "🌧️", "🌧️"], 65: ["Heavy rain", "🌧️", "🌧️"],
    66: ["Freezing rain", "🌧️", "🌧️"], 67: ["Freezing rain", "🌧️", "🌧️"],
    71: ["Light snow", "🌨️", "🌨️"], 73: ["Snow", "🌨️", "🌨️"], 75: ["Heavy snow", "❄️", "❄️"],
    77: ["Snow grains", "🌨️", "🌨️"], 80: ["Rain showers", "🌦️", "🌧️"], 81: ["Rain showers", "🌧️", "🌧️"],
    82: ["Violent showers", "⛈️", "⛈️"], 85: ["Snow showers", "🌨️", "🌨️"], 86: ["Snow showers", "❄️", "❄️"],
    95: ["Thunderstorm", "⛈️", "⛈️"], 96: ["Thunderstorm, hail", "⛈️", "⛈️"], 99: ["Thunderstorm, hail", "⛈️", "⛈️"],
  };
  const wmo = (code, isDay = 1) => {
    const w = WMO[code] || ["Unknown", "❔", "❔"];
    return { text: w[0], icon: isDay ? w[1] : w[2] };
  };

  // ------------------------------------------------------------------
  // Colour scales for the grid layers: [value, [r, g, b, alpha]]
  // ------------------------------------------------------------------
  const SCALES = {
    temperature: {
      title: "Temperature", unit: () => (imperial() ? "°F" : "°C"),
      label: (v) => Math.round(imperial() ? v * 9 / 5 + 32 : v),
      stops: [[-40, [145, 60, 190, 210]], [-20, [70, 90, 220, 210]], [0, [80, 190, 230, 200]],
        [10, [90, 200, 120, 200]], [20, [240, 220, 80, 200]], [30, [245, 140, 50, 210]],
        [40, [215, 40, 40, 220]], [50, [120, 10, 30, 230]]],
    },
    wind: {
      title: "Wind speed", unit: () => (imperial() ? "mph" : "km/h"),
      label: (v) => Math.round(imperial() ? v / 1.609 : v),
      stops: [[0, [40, 70, 160, 170]], [10, [40, 150, 180, 180]], [25, [70, 190, 110, 190]],
        [40, [230, 210, 70, 200]], [60, [240, 130, 50, 210]], [90, [210, 40, 50, 220]],
        [130, [190, 40, 190, 230]]],
    },
    precipitation: {
      title: "Precipitation", unit: () => (imperial() ? "in/h" : "mm/h"),
      label: (v) => (imperial() ? (v / 25.4).toFixed(2) : v),
      stops: [[0, [0, 0, 0, 0]], [0.1, [120, 190, 255, 120]], [1, [40, 120, 240, 190]],
        [4, [50, 200, 90, 210]], [10, [250, 220, 50, 220]], [25, [240, 60, 40, 230]],
        [50, [200, 40, 200, 240]]],
    },
    clouds: {
      title: "Cloud cover", unit: () => "%", label: (v) => v,
      stops: [[0, [255, 255, 255, 0]], [30, [230, 235, 245, 60]], [70, [235, 240, 250, 150]],
        [100, [250, 250, 255, 215]]],
    },
    humidity: {
      title: "Relative humidity", unit: () => "%", label: (v) => v,
      stops: [[0, [170, 110, 50, 190]], [30, [220, 190, 90, 180]], [60, [90, 190, 160, 180]],
        [80, [60, 140, 220, 190]], [100, [40, 60, 180, 210]]],
    },
    pressure: {
      title: "Sea-level pressure", unit: () => "hPa", label: (v) => v,
      stops: [[960, [130, 50, 170, 200]], [990, [50, 110, 220, 190]], [1013, [80, 190, 140, 180]],
        [1030, [240, 210, 80, 190]], [1050, [220, 70, 50, 210]]],
    },
  };

  function colorAt(scale, v) {
    const s = scale.stops;
    if (v <= s[0][0]) return s[0][1];
    for (let i = 1; i < s.length; i++) {
      if (v <= s[i][0]) {
        const [v0, c0] = s[i - 1];
        const [v1, c1] = s[i];
        const t = (v - v0) / (v1 - v0);
        return c0.map((c, k) => c + (c1[k] - c) * t);
      }
    }
    return s[s.length - 1][1];
  }

  function renderLegend(layer) {
    const legend = $("legend");
    const scale = SCALES[layer];
    if (!scale) { legend.hidden = true; return; }
    const s = scale.stops;
    const lo = s[0][0];
    const hi = s[s.length - 1][0];
    const grad = s.map(([v, c]) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(c[3], 90) / 255}) ${((v - lo) / (hi - lo)) * 100}%`);
    $("legend-title").textContent = `${scale.title} (${scale.unit()})`;
    $("legend-bar").style.background = `linear-gradient(to right, ${grad.join(",")})`;
    $("legend-labels").innerHTML = s.map(([v]) => `<span>${scale.label(v)}</span>`).join("");
    legend.hidden = false;
  }

  function renderRadarLegend() {
    $("legend-title").textContent = "Radar reflectivity";
    $("legend-bar").style.background =
      "linear-gradient(to right, #9be1ff, #0d96ff, #00c800, #ffe600, #ff8c00, #ff0000, #c800c8)";
    $("legend-labels").innerHTML = "<span>Light</span><span>Moderate</span><span>Heavy</span><span>Extreme</span>";
    $("legend").hidden = false;
  }

  // ------------------------------------------------------------------
  // Map + base layers
  // ------------------------------------------------------------------
  function parseHash() {
    const m = window.location.hash.match(/^#(-?[\d.]+),(-?[\d.]+),([\d.]+)z(?:\/(\w+))?/);
    if (!m) return null;
    return { lat: +m[1], lon: +m[2], zoom: +m[3], layer: m[4] };
  }
  const initial = parseHash() || { lat: 22, lon: 78, zoom: 4 };

  const map = L.map("map", {
    center: [initial.lat, initial.lon],
    zoom: initial.zoom,
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: true,
    zoomControl: false,
    keyboard: false,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  map.createPane("heat").style.zIndex = 350;
  map.createPane("radar").style.zIndex = 360;
  map.createPane("labels").style.zIndex = 640;
  map.getPane("labels").style.pointerEvents = "none";

  const todayUTC = () => new Date().toISOString().slice(0, 10);
  const yesterdayUTC = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

  const gibsUrl = (layer, level) =>
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/{time}/${level}/{z}/{y}/{x}.jpg`;
  const GIBS_ATTR = 'Imagery <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>';

  const baseLayers = {
    esri: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" },
    ),
    viirs: L.tileLayer(gibsUrl("VIIRS_SNPP_CorrectedReflectance_TrueColor", "GoogleMapsCompatible_Level9"), {
      maxNativeZoom: 9, maxZoom: 12, time: yesterdayUTC(), attribution: GIBS_ATTR,
    }),
    modis: L.tileLayer(gibsUrl("MODIS_Terra_CorrectedReflectance_TrueColor", "GoogleMapsCompatible_Level9"), {
      maxNativeZoom: 9, maxZoom: 12, time: yesterdayUTC(), attribution: GIBS_ATTR,
    }),
    dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    }),
  };
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", {
    pane: "labels", maxZoom: 19, subdomains: "abcd",
  }).addTo(map);

  let currentBase = null;
  function setBase(key) {
    const layer = baseLayers[key] || baseLayers.esri;
    if (currentBase) map.removeLayer(currentBase);
    currentBase = layer.addTo(map);
    const isGibs = key === "viirs" || key === "modis";
    $("sat-date").hidden = !isGibs;
    try { localStorage.setItem("base", key); } catch (e) { /* ignore */ }
  }

  const satDate = $("sat-date");
  satDate.max = todayUTC();
  satDate.value = yesterdayUTC();
  satDate.addEventListener("change", () => {
    if (!satDate.value) return;
    baseLayers.viirs.options.time = satDate.value;
    baseLayers.modis.options.time = satDate.value;
    baseLayers.viirs.redraw();
    baseLayers.modis.redraw();
  });

  let savedBase = "esri";
  try { savedBase = localStorage.getItem("base") || "esri"; } catch (e) { /* ignore */ }
  $("sat-source").value = baseLayers[savedBase] ? savedBase : "esri";
  setBase($("sat-source").value);
  $("sat-source").addEventListener("change", (e) => setBase(e.target.value));

  // ------------------------------------------------------------------
  // Timeline
  // ------------------------------------------------------------------
  const timeline = {
    frames: [], // [{time: unixSeconds, future: bool}]
    index: 0,
    timer: null,
    onChange: null,
    speed: 700,
  };

  function setTimeline(frames, index, onChange, speed = 700) {
    stopPlayback();
    timeline.frames = frames;
    timeline.onChange = onChange;
    timeline.speed = speed;
    $("timeline").hidden = frames.length === 0;
    $("time-slider").max = Math.max(0, frames.length - 1);
    showFrame(index);
  }

  function clearTimeline() {
    stopPlayback();
    timeline.frames = [];
    timeline.onChange = null;
    $("timeline").hidden = true;
  }

  function showFrame(index) {
    if (!timeline.frames.length) return;
    timeline.index = clamp(index, 0, timeline.frames.length - 1);
    $("time-slider").value = timeline.index;
    const f = timeline.frames[timeline.index];
    const d = new Date(f.time * 1000);
    $("time-label").textContent = d.toLocaleString(undefined, {
      weekday: "short", hour: "2-digit", minute: "2-digit",
    });
    const diffMin = Math.round((f.time * 1000 - Date.now()) / 60000);
    const badge = $("time-badge");
    if (Math.abs(diffMin) < 30) badge.textContent = "now";
    else if (diffMin > 0) badge.textContent = diffMin < 120 ? `+${diffMin} min` : `+${Math.round(diffMin / 60)} h`;
    else badge.textContent = -diffMin < 120 ? `${diffMin} min` : `${Math.round(diffMin / 60)} h`;
    badge.classList.toggle("future", diffMin >= 30 || f.future);
    if (timeline.onChange) timeline.onChange(timeline.index);
  }

  function stopPlayback() {
    clearInterval(timeline.timer);
    timeline.timer = null;
    $("play-btn").textContent = "▶";
    $("play-btn").setAttribute("aria-label", "Play");
  }

  $("play-btn").addEventListener("click", () => {
    if (timeline.timer) { stopPlayback(); return; }
    $("play-btn").textContent = "❚❚";
    $("play-btn").setAttribute("aria-label", "Pause");
    timeline.timer = setInterval(() => {
      showFrame((timeline.index + 1) % timeline.frames.length);
    }, timeline.speed);
  });
  $("time-slider").addEventListener("input", (e) => { stopPlayback(); showFrame(+e.target.value); });

  const nearestNowIndex = (frames) => {
    const now = Date.now() / 1000;
    let best = 0;
    frames.forEach((f, i) => { if (Math.abs(f.time - now) < Math.abs(frames[best].time - now)) best = i; });
    return best;
  };

  // ------------------------------------------------------------------
  // Radar layer (RainViewer)
  // ------------------------------------------------------------------
  const radar = { host: "", frames: [], layers: {}, shown: null, loadedAt: 0 };

  function radarLayer(frame) {
    if (!radar.layers[frame.path]) {
      radar.layers[frame.path] = L.tileLayer(`${radar.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        pane: "radar", opacity: 0, maxNativeZoom: 7, maxZoom: 12, tileSize: 256,
        attribution: 'Radar <a href="https://www.rainviewer.com/">RainViewer</a>',
      });
    }
    return radar.layers[frame.path];
  }

  function showRadarFrame(i) {
    const frame = radar.frames[i];
    if (!frame) return;
    const layer = radarLayer(frame);
    if (!map.hasLayer(layer)) layer.addTo(map);
    if (radar.shown && radar.shown !== layer) radar.shown.setOpacity(0);
    layer.setOpacity(0.8);
    radar.shown = layer;
    // Preload the next frame so playback is smooth.
    const next = radar.frames[(i + 1) % radar.frames.length];
    const nextLayer = radarLayer(next);
    if (!map.hasLayer(nextLayer)) nextLayer.addTo(map);
  }

  function removeRadar() {
    Object.values(radar.layers).forEach((l) => map.removeLayer(l));
    radar.shown = null;
  }

  async function enableRadar() {
    try {
      if (Date.now() - radar.loadedAt > 5 * 60 * 1000) {
        const data = await api("/api/radar");
        removeRadar();
        radar.layers = {};
        radar.host = data.host;
        radar.frames = data.frames;
        radar.loadedAt = Date.now();
      }
      if (state.layer !== "radar") return;
      if (!radar.frames.length) { toast("No radar frames available right now."); return; }
      renderRadarLegend();
      const lastPast = radar.frames.map((f) => !f.nowcast).lastIndexOf(true);
      setTimeline(radar.frames.map((f) => ({ time: f.time, future: f.nowcast })),
        lastPast >= 0 ? lastPast : radar.frames.length - 1, showRadarFrame, 500);
    } catch (err) {
      toast(err.message);
    }
  }

  // ------------------------------------------------------------------
  // Grid layers (temperature, wind, ...) rendered as a smooth image overlay
  // ------------------------------------------------------------------
  const grid = { data: null, overlay: null, controller: null, frame: 0 };

  function interpolate(field, rows, cols, gx, gy) {
    gx = clamp(gx, 0, cols - 1);
    gy = clamp(gy, 0, rows - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, cols - 1), y1 = Math.min(y0 + 1, rows - 1);
    const tx = gx - x0, ty = gy - y0;
    const a = field[y0][x0], b = field[y0][x1], c = field[y1][x0], d = field[y1][x1];
    if (a == null || b == null || c == null || d == null) return a ?? b ?? c ?? d ?? null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  function gridImage(data, frame) {
    const S = 10;
    const { rows, cols } = data;
    const scale = SCALES[data.layer];
    const field = data.values[frame];
    const canvas = document.createElement("canvas");
    canvas.width = cols * S;
    canvas.height = rows * S;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let py = 0; py < canvas.height; py++) {
      const gy = (py + 0.5) / S - 0.5;
      for (let px = 0; px < canvas.width; px++) {
        const v = interpolate(field, rows, cols, (px + 0.5) / S - 0.5, gy);
        if (v == null) continue;
        const c = colorAt(scale, v);
        const o = (py * canvas.width + px) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL();
  }

  function showGridFrame(i) {
    const data = grid.data;
    if (!data) return;
    grid.frame = i;
    const b = data.bounds;
    const bounds = [[b.south, b.west], [b.north, b.east]];
    const url = gridImage(data, i);
    if (grid.overlay) {
      grid.overlay.setUrl(url);
      grid.overlay.setBounds(L.latLngBounds(bounds));
    } else {
      grid.overlay = L.imageOverlay(url, bounds, {
        pane: "heat", opacity: 0.75,
        attribution: 'Forecast <a href="https://open-meteo.com/">Open-Meteo</a>',
      }).addTo(map);
    }
    if (data.layer === "wind") wind.setField(data, i);
  }

  function removeGrid() {
    if (grid.controller) grid.controller.abort();
    if (grid.overlay) map.removeLayer(grid.overlay);
    grid.overlay = null;
    grid.data = null;
    wind.stop();
  }

  function viewBounds() {
    const b = map.getBounds().pad(0.15);
    let west = b.getWest(), east = b.getEast();
    if (east - west > 360) {
      const c = map.getCenter().lng;
      west = c - 180;
      east = c + 180;
    }
    return {
      south: clamp(b.getSouth(), -85, 85).toFixed(2),
      north: clamp(b.getNorth(), -85, 85).toFixed(2),
      west: west.toFixed(2),
      east: east.toFixed(2),
    };
  }

  async function loadGrid(layer) {
    if (grid.controller) grid.controller.abort();
    const controller = new AbortController();
    grid.controller = controller;
    try {
      const data = await api("/api/grid", { layer, ...viewBounds() }, { signal: controller.signal });
      if (state.layer !== layer || controller.signal.aborted) return;
      const keepTime = grid.data && grid.data.layer === layer
        ? grid.data.times[timeline.index] : null;
      grid.data = data;
      renderLegend(layer);
      const frames = data.times.map((t) => ({ time: t, future: false }));
      let idx = keepTime != null ? data.times.indexOf(keepTime) : -1;
      if (idx < 0) idx = nearestNowIndex(frames);
      setTimeline(frames, idx, showGridFrame, 900);
    } catch (err) {
      if (err.name !== "AbortError") toast(err.message);
    }
  }

  // ------------------------------------------------------------------
  // Animated wind particles
  // ------------------------------------------------------------------
  const wind = (() => {
    const canvas = document.createElement("canvas");
    canvas.className = "wind-canvas";
    map.getContainer().appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let field = null;
    let particles = [];
    let raf = null;
    let w = 0, h = 0;

    function resize() {
      const size = map.getSize();
      const dpr = window.devicePixelRatio || 1;
      w = size.x; h = size.y;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function spawn(p = {}) {
      p.x = Math.random() * w;
      p.y = Math.random() * h;
      p.age = Math.floor(Math.random() * 80);
      return p;
    }

    function velocity(x, y) {
      if (!field) return null;
      const { nw, se, rows, cols, u, v } = field;
      const gx = ((x - nw.x) / (se.x - nw.x)) * cols - 0.5;
      const gy = ((y - nw.y) / (se.y - nw.y)) * rows - 0.5;
      if (gx < -0.5 || gy < -0.5 || gx > cols - 0.5 || gy > rows - 0.5) return null;
      const uu = interpolate(u, rows, cols, gx, gy);
      const vv = interpolate(v, rows, cols, gx, gy);
      if (uu == null || vv == null) return null;
      return [uu, vv];
    }

    function frame() {
      ctx.save();
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "rgba(0,0,0,0.92)";
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      const k = 0.035 * Math.pow(1.15, map.getZoom() - 3);
      for (const p of particles) {
        const vel = velocity(p.x, p.y);
        if (!vel || p.age++ > 90) { spawn(p); p.age = 0; continue; }
        const nx = p.x + vel[0] * k;
        const ny = p.y - vel[1] * k;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(nx, ny);
        p.x = nx; p.y = ny;
      }
      ctx.stroke();
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (raf || !field) return;
      resize();
      const count = Math.min(4500, Math.round((w * h) / 450));
      particles = Array.from({ length: count }, () => spawn());
      canvas.hidden = false;
      raf = requestAnimationFrame(frame);
    }

    function pause() {
      cancelAnimationFrame(raf);
      raf = null;
      ctx.clearRect(0, 0, w, h);
      canvas.hidden = true;
    }

    function project() {
      if (!field) return;
      const b = field.bounds;
      field.nw = map.latLngToContainerPoint([b.north, b.west]);
      field.se = map.latLngToContainerPoint([b.south, b.east]);
    }

    map.on("movestart zoomstart", pause);
    map.on("moveend", () => { if (field) { project(); start(); } });
    map.on("resize", () => { if (raf) { pause(); start(); } });

    return {
      setField(data, i) {
        field = { bounds: data.bounds, rows: data.rows, cols: data.cols, u: data.u[i], v: data.v[i] };
        project();
        start();
      },
      stop() { field = null; pause(); },
    };
  })();

  // ------------------------------------------------------------------
  // Layer switching
  // ------------------------------------------------------------------
  function setLayer(layer) {
    state.layer = layer;
    document.querySelectorAll(".layer-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.layer === layer);
    });
    removeRadar();
    removeGrid();
    clearTimeline();
    $("legend").hidden = true;

    if (layer === "radar") enableRadar();
    else if (SCALES[layer]) loadGrid(layer);
    updateHash();
  }

  document.querySelectorAll(".layer-btn").forEach((btn) => {
    btn.addEventListener("click", () => setLayer(btn.dataset.layer));
  });

  const reloadGrid = debounce(() => { if (SCALES[state.layer]) loadGrid(state.layer); }, 400);
  map.on("moveend", () => { updateHash(); reloadGrid(); });

  function updateHash() {
    const c = map.getCenter();
    const lng = ((c.lng + 540) % 360) - 180;
    const hash = `#${c.lat.toFixed(2)},${lng.toFixed(2)},${map.getZoom()}z/${state.layer}`;
    history.replaceState(null, "", hash);
  }

  // Refresh radar periodically while it is shown.
  setInterval(() => {
    if (state.layer === "radar" && !timeline.timer) { radar.loadedAt = 0; setLayer("radar"); }
  }, 10 * 60 * 1000);

  // ------------------------------------------------------------------
  // Storms, fires, volcanoes (NASA EONET)
  // ------------------------------------------------------------------
  const eventsLayer = L.layerGroup();
  const EVENT_ICONS = { storm: "🌀", fire: "🔥", volcano: "🌋" };

  async function loadEvents() {
    try {
      const { events } = await api("/api/events");
      eventsLayer.clearLayers();
      events.forEach((ev) => {
        if (ev.track.length > 1) {
          L.polyline(ev.track, { color: "#ff5d5d", weight: 2, dashArray: "4 6", opacity: 0.9 })
            .addTo(eventsLayer);
        }
        const icon = L.divIcon({
          className: "",
          html: `<div class="event-icon ${ev.type}">${EVENT_ICONS[ev.type] || "⚠️"}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        const date = ev.date ? new Date(ev.date).toLocaleString() : "";
        const mag = ev.magnitude != null ? `<br>${escapeHtml(ev.magnitude)} ${escapeHtml(ev.magnitude_unit || "")}` : "";
        const link = ev.link ? `<br><a href="${escapeHtml(ev.link)}" target="_blank" rel="noopener">Source</a>` : "";
        L.marker([ev.lat, ev.lon], { icon, title: ev.title })
          .bindPopup(`<div class="event-popup"><b>${escapeHtml(ev.title)}</b><br><small>${escapeHtml(date)}</small>${mag}${link}</div>`)
          .addTo(eventsLayer);
      });
    } catch (err) {
      toast(err.message);
    }
  }

  function setEvents(on) {
    state.showEvents = on;
    $("events-toggle").classList.toggle("active", on);
    if (on) { eventsLayer.addTo(map); loadEvents(); } else map.removeLayer(eventsLayer);
  }
  $("events-toggle").addEventListener("click", () => setEvents(!state.showEvents));

  // ------------------------------------------------------------------
  // Location forecast panel
  // ------------------------------------------------------------------
  let pin = null;
  let forecastController = null;
  let lastPlace = null;

  async function openForecast(lat, lon, place) {
    lastPlace = { lat, lon, place };
    lon = ((lon + 540) % 360) - 180;
    if (pin) pin.setLatLng([lat, lon]); else pin = L.marker([lat, lon]).addTo(map);
    const panel = $("info-panel");
    panel.hidden = false;
    $("info-content").innerHTML = `<div class="info-place">${escapeHtml(place || "Loading…")}</div>`;
    if (forecastController) forecastController.abort();
    forecastController = new AbortController();
    try {
      const data = await api("/api/weather", { lat: lat.toFixed(3), lon: lon.toFixed(3) },
        { signal: forecastController.signal });
      lastPlace.data = data;
      renderForecast(data, place);
    } catch (err) {
      if (err.name !== "AbortError") {
        $("info-content").innerHTML = `<div class="info-place">${escapeHtml(place || "")}</div><p>${escapeHtml(err.message)}</p>`;
      }
    }
  }

  function renderForecast(d, place) {
    const cur = d.current;
    const now = wmo(cur.weather_code, cur.is_day);
    const coords = `${d.latitude.toFixed(2)}°, ${d.longitude.toFixed(2)}°`;
    const tzFmt = (iso, opts) => new Date(`${iso}`).toLocaleString(undefined, opts);

    const hourly = d.hourly.time.map((t, i) => {
      const w = wmo(d.hourly.weather_code[i], d.hourly.is_day[i]);
      const pp = d.hourly.precipitation_probability[i];
      return `<div><div>${tzFmt(t, { hour: "2-digit" })}</div><div class="ico" title="${w.text}">${w.icon}</div>
        <div>${fmtTemp(d.hourly.temperature_2m[i])}</div><div class="pp">${pp ? `${pp}%` : "&nbsp;"}</div></div>`;
    }).join("");

    const daily = d.daily.time.map((t, i) => {
      const w = wmo(d.daily.weather_code[i]);
      const pp = d.daily.precipitation_probability_max[i];
      const day = i === 0 ? "Today" : tzFmt(`${t}T12:00`, { weekday: "short" });
      return `<div class="daily-row"><span>${day}</span><span title="${w.text}">${w.icon}</span>
        <span class="pp">${pp ? `💧${pp}%` : ""}</span>
        <span class="range"><b>${fmtTemp(d.daily.temperature_2m_max[i])}</b> / ${fmtTemp(d.daily.temperature_2m_min[i])}</span></div>`;
    }).join("");

    const sunrise = tzFmt(d.daily.sunrise[0], { hour: "2-digit", minute: "2-digit" });
    const sunset = tzFmt(d.daily.sunset[0], { hour: "2-digit", minute: "2-digit" });

    $("info-content").innerHTML = `
      <div class="info-place">${escapeHtml(place || coords)}</div>
      <div class="info-sub">${place ? `${coords} · ` : ""}${escapeHtml(d.timezone || "")}</div>
      <div class="info-now">
        <div class="big-icon">${now.icon}</div>
        <div><div class="temp">${fmtTemp(cur.temperature_2m)}</div><div>${now.text}</div></div>
      </div>
      <div class="info-grid">
        <div><span>Feels like</span>${fmtTemp(cur.apparent_temperature)}</div>
        <div><span>Humidity</span>${cur.relative_humidity_2m}%</div>
        <div><span>Wind</span>${fmtWind(cur.wind_speed_10m)} ${compass(cur.wind_direction_10m)}</div>
        <div><span>Gusts</span>${fmtWind(cur.wind_gusts_10m)}</div>
        <div><span>Pressure</span>${Math.round(cur.pressure_msl)} hPa</div>
        <div><span>Clouds</span>${cur.cloud_cover}%</div>
        <div><span>Precip</span>${fmtPrecip(cur.precipitation)}</div>
        <div><span>Daily rain</span>${fmtPrecip(d.daily.precipitation_sum[0])}</div>
        <div><span>Sunrise</span>${sunrise}</div>
        <div><span>Sunset</span>${sunset}</div>
      </div>
      <div class="section-title">Next 24 hours</div>
      <div class="hourly">${hourly}</div>
      <div class="section-title">7-day forecast</div>
      ${daily}`;
  }

  $("info-close").addEventListener("click", () => {
    $("info-panel").hidden = true;
    if (pin) { map.removeLayer(pin); pin = null; }
    lastPlace = null;
  });

  map.on("click", (e) => openForecast(e.latlng.lat, e.latlng.lng));

  // ------------------------------------------------------------------
  // Search + geolocation
  // ------------------------------------------------------------------
  const input = $("search-input");
  const list = $("search-results");
  let results = [];
  let active = -1;

  function placeLabel(r) {
    return [r.name, r.admin1, r.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
  }

  function renderResults() {
    list.innerHTML = results.map((r, i) =>
      `<li data-i="${i}" class="${i === active ? "active" : ""}">${escapeHtml(r.name)}
        <small>${escapeHtml([r.admin1, r.country].filter(Boolean).join(", "))}</small></li>`).join("");
    list.hidden = results.length === 0;
  }

  function choose(r) {
    results = [];
    renderResults();
    input.value = placeLabel(r);
    input.blur();
    map.flyTo([r.lat, r.lon], Math.max(map.getZoom(), 7), { duration: 1.2 });
    openForecast(r.lat, r.lon, placeLabel(r));
  }

  const doSearch = debounce(async (q) => {
    if (q.trim().length < 2) { results = []; renderResults(); return; }
    try {
      const data = await api("/api/search", { q });
      if (input.value !== q) return;
      results = data.results;
      active = results.length ? 0 : -1;
      renderResults();
    } catch (err) {
      toast(err.message);
    }
  }, 300);

  input.addEventListener("input", () => doSearch(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      renderResults();
    } else if (e.key === "Enter" && results[active]) {
      choose(results[active]);
    } else if (e.key === "Escape") {
      results = []; renderResults();
    }
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) { e.preventDefault(); choose(results[+li.dataset.i]); }
  });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 150));
  input.addEventListener("focus", () => { if (results.length) list.hidden = false; });

  $("locate-btn").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("Geolocation is not supported by this browser."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.flyTo([latitude, longitude], 8, { duration: 1.2 });
        openForecast(latitude, longitude, "My location");
      },
      () => toast("Could not get your location."),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  });

  // ------------------------------------------------------------------
  // Units toggle
  // ------------------------------------------------------------------
  function renderUnits() {
    $("units-label").textContent = imperial() ? "°F" : "°C";
    if (SCALES[state.layer]) renderLegend(state.layer);
    if (lastPlace && lastPlace.data) renderForecast(lastPlace.data, lastPlace.place);
  }
  $("units-toggle").addEventListener("click", () => {
    state.units = imperial() ? "metric" : "imperial";
    try { localStorage.setItem("units", state.units); } catch (e) { /* ignore */ }
    renderUnits();
  });

  // ------------------------------------------------------------------
  // Keyboard shortcuts: space = play/pause, ←/→ = step timeline
  // ------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea") || !timeline.frames.length) return;
    if (e.key === " ") { e.preventDefault(); $("play-btn").click(); }
    else if (e.key === "ArrowRight") { stopPlayback(); showFrame(timeline.index + 1); }
    else if (e.key === "ArrowLeft") { stopPlayback(); showFrame(timeline.index - 1); }
  });

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  renderUnits();
  setEvents(true);
  const startLayer = initial.layer && (initial.layer === "radar" || initial.layer === "satellite" || SCALES[initial.layer])
    ? initial.layer : "satellite";
  setLayer(startLayer);
})();
