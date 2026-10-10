/* El Niño tracker: live Earth (map + 3D globe) with Pacific sea temperature
   anomalies, the Niño monitoring regions and NOAA's ENSO status. */
(() => {
  "use strict";

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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

  const STATIC_SITE = Boolean(window.APP_CONFIG && window.APP_CONFIG.static);

  async function api(path, params = {}, { signal } = {}) {
    if (STATIC_SITE) {
      // GitHub Pages demo: no server, the browser fetches the data itself.
      setLoading(true);
      try { return await window.StaticApi.handle(path, params, signal); } finally { setLoading(false); }
    }
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
  // Map + base layers
  // ------------------------------------------------------------------
  function parseHash() {
    const m = window.location.hash.match(/^#(-?[\d.]+),(-?[\d.]+),([\d.]+)z/);
    if (!m) return null;
    return { lat: +m[1], lon: +m[2], zoom: +m[3] };
  }
  const linkedView = Boolean(parseHash()); // read before the map rewrites the hash
  const PACIFIC = [[-25, -215], [25, -70]];

  const map = L.map("map", {
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: true,
    zoomControl: false,
    keyboard: false,
  });
  const initial = parseHash();
  if (initial) map.setView([initial.lat, initial.lon], initial.zoom);
  else map.fitBounds(PACIFIC);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  map.createPane("sst").style.zIndex = 350;
  map.createPane("labels").style.zIndex = 640;
  map.getPane("labels").style.pointerEvents = "none";

  map.on("moveend", () => {
    const c = map.getCenter();
    const lng = ((c.lng + 540) % 360) - 180;
    history.replaceState(null, "", `#${c.lat.toFixed(2)},${lng.toFixed(2)},${map.getZoom()}z`);
  });

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
    dark: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 16, maxZoom: 19, attribution: "Map &copy; Esri, HERE, Garmin, OpenStreetMap contributors" },
    ),
  };
  // Country borders and place names on top of every layer (no API key needed).
  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { pane: "labels", maxNativeZoom: 16, maxZoom: 19 },
  ).addTo(map);

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
  // Live clouds: geostationary satellites stitched into one global layer
  // ------------------------------------------------------------------
  const SAT_LAT_LIMIT = 81; // edge of the geostationary disks

  // Is a longitude range (any world copy) overlapping a satellite's band?
  function overlapsBand(w, e, band) {
    const shift = Math.floor((w + 180) / 360) * 360;
    w -= shift; e -= shift;
    return [-360, 0, 360].some((off) => w < band[1] + off && e > band[0] + off);
  }

  // Tile layers that only request tiles inside their satellite's band.
  // (Declaring `band` as an option also keeps it out of WMS request params.)
  const bandLimited = (Base) => Base.extend({
    options: { band: [-180, 180] },
    _isValidTile(coords) {
      if (!Base.prototype._isValidTile.call(this, coords)) return false;
      const n = Math.pow(2, coords.z);
      return overlapsBand((coords.x / n) * 360 - 180, ((coords.x + 1) / n) * 360 - 180, this.options.band);
    },
  });
  const BandTileLayer = bandLimited(L.TileLayer);
  const BandWMSLayer = bandLimited(L.TileLayer.WMS);

  const clouds = { layers: [], panes: [], style: "truecolor", data: null };
  try { clouds.style = localStorage.getItem("liveStyle") || "truecolor"; } catch (e) { /* ignore */ }
  if (!["truecolor", "infrared", "off"].includes(clouds.style)) clouds.style = "truecolor";
  $("live-style").value = clouds.style;

  // Clip each satellite's pane exactly to its longitude band, in every world copy.
  function clipSatellitePanes() {
    clouds.panes.forEach(({ pane, band }) => {
      const d = [-360, 0, 360].map((off) => {
        const a = map.latLngToLayerPoint([SAT_LAT_LIMIT, band[0] + off]);
        const b = map.latLngToLayerPoint([-SAT_LAT_LIMIT, band[1] + off]);
        return `M${a.x} ${a.y}H${b.x}V${b.y}H${a.x}Z`;
      }).join("");
      pane.style.clipPath = `path("${d}")`;
    });
  }
  map.on("zoomend viewreset", clipSatellitePanes);
  map.on("zoomstart", () => clouds.panes.forEach(({ pane }) => { pane.style.clipPath = "none"; }));

  function satellitePane(sat) {
    const name = `sat-${sat.id}`;
    let pane = map.getPane(name);
    if (!pane) {
      pane = map.createPane(name);
      pane.style.zIndex = 300;
      pane.classList.add("sat-pane");
      clouds.panes.push({ pane, band: sat.band });
    }
    // Infrared clouds are blended over the base map; true colour is drawn as is.
    pane.classList.toggle("sat-blend", sat.style === "infrared");
    return name;
  }

  async function loadClouds() {
    clouds.layers.forEach((l) => map.removeLayer(l));
    clouds.layers = [];
    clouds.data = null;
    $("clouds-time").textContent = "";
    const style = clouds.style;
    if (style === "off") return;
    try {
      const data = await api("/api/satellites", { style });
      if (clouds.style !== style) return;
      clouds.data = data;
      clouds.layers = data.layers.map((sat) => {
        const opts = {
          pane: satellitePane(sat),
          band: sat.band,
          maxNativeZoom: sat.max_native_zoom,
          maxZoom: 12,
          opacity: sat.style === "infrared" ? 0.9 : 1,
          bounds: [[-SAT_LAT_LIMIT, -540], [SAT_LAT_LIMIT, 540]],
          attribution: sat.attribution,
        };
        const layer = sat.type === "wms"
          ? new BandWMSLayer(sat.url, { ...opts, layers: sat.layer, format: "image/png", transparent: true, version: "1.3.0" })
          : new BandTileLayer(sat.url, opts);
        return layer.addTo(map);
      });
      clipSatellitePanes();
      const t = new Date(data.time);
      const mins = Math.round((Date.now() - t) / 60000);
      $("clouds-time").textContent = `${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} (${mins} min ago) · ${data.layers.length} satellites`;
      $("clouds-time").title = data.layers.map((l) => `${l.name} (${l.agency})`).join(", ");
      if (!$("sources-panel").hidden) renderSources();
      if (typeof updateGlobeSatellites === "function") updateGlobeSatellites();
    } catch (err) {
      toast(`Live satellites: ${err.message}`);
    }
  }

  $("live-style").addEventListener("change", (e) => {
    clouds.style = e.target.value;
    try { localStorage.setItem("liveStyle", clouds.style); } catch (err) { /* ignore */ }
    loadClouds();
  });
  // New images arrive every 10 minutes.
  setInterval(() => { if (clouds.style !== "off") loadClouds(); }, 10 * 60 * 1000);

  // ------------------------------------------------------------------
  // Live day/night shading (computed from the sun's current position)
  // ------------------------------------------------------------------
  map.createPane("night").style.zIndex = 330;
  map.getPane("night").style.pointerEvents = "none";
  const night = { layer: null, on: true };
  try { night.on = localStorage.getItem("night") !== "off"; } catch (e) { /* ignore */ }
  $("night-toggle").checked = night.on;

  function sunPosition(date) {
    const rad = Math.PI / 180;
    const n = date.getTime() / 864e5 + 2440587.5 - 2451545.0; // days since J2000
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * rad;
    const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
    const eps = (23.439 - 0.0000004 * n) * rad;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    let lon = ra / rad - gmst * 15;
    lon = ((lon + 540) % 360) - 180;
    return { lat: dec / rad, lon };
  }

  function nightPolygon(date) {
    const rad = Math.PI / 180;
    const sun = sunPosition(date);
    let dec = sun.lat * rad;
    if (Math.abs(dec) < 0.001) dec = 0.001;
    const pts = [];
    for (let lon = -540; lon <= 540; lon += 2) {
      const lat = Math.atan(-Math.cos((lon - sun.lon) * rad) / Math.tan(dec)) / rad;
      pts.push([lat, lon]);
    }
    const pole = dec > 0 ? -85 : 85; // the pole tilted away from the sun is dark
    pts.push([pole, 540], [pole, -540]);
    return pts;
  }

  function updateNight() {
    if (night.layer) { map.removeLayer(night.layer); night.layer = null; }
    if (!night.on) return;
    night.layer = L.polygon(nightPolygon(new Date()), {
      pane: "night", stroke: false, fillColor: "#000814", fillOpacity: 0.38, interactive: false,
    }).addTo(map);
  }
  $("night-toggle").addEventListener("change", (e) => {
    night.on = e.target.checked;
    try { localStorage.setItem("night", night.on ? "on" : "off"); } catch (err) { /* ignore */ }
    updateNight();
    updateGlobeNight();
  });
  setInterval(() => { updateNight(); updateGlobeNight(); }, 5 * 60 * 1000);

  // ------------------------------------------------------------------
  // Sources panel: every data source with links and image times
  // ------------------------------------------------------------------
  const STATIC_SOURCES = [
    ["High-res base imagery, labels, dark map", "Esri World Imagery / Reference", "https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9"],
    ["Daily true-colour imagery", "NASA GIBS (VIIRS, MODIS)", "https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api"],
  ];

  function renderSources() {
    const live = clouds.data;
    const link = (url, text) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
    const satRows = live ? live.layers.map((l) => `
      <tr>
        <td><b>${escapeHtml(l.name)}</b><br><small>${link(l.homepage, l.agency)} · ${Math.abs(l.longitude)}°${l.longitude < 0 ? "W" : "E"}</small></td>
        <td>${escapeHtml(l.product)}<br><small><code>${escapeHtml(l.layer)}</code></small></td>
        <td>${escapeHtml(new Date(l.time).toISOString().slice(11, 16))} UTC</td>
        <td>${link(l.provider_url, l.provider)}<br><small><span class="dot ${l.verified ? "ok" : "guess"}"></span>${l.verified ? "found in provider catalogue" : "provider unreachable, using known name"}</small></td>
      </tr>`).join("") : "";
    const ensoSources = enso.data ? enso.data.sources.map((src) => `<li>${link(src.url, src.name)}</li>`).join("") : "";
    $("sources-content").innerHTML = `
      <h2>Data sources</h2>
      <p>Everything here comes from free, public sources. Satellite images are near real time:
         geostationary satellites scan the full Earth every 10 minutes and images appear here about 20–40 minutes later.</p>
      <h3>Live satellites</h3>
      ${live && live.style === "truecolor" ? "<p>True colour uses each satellite's GeoColor product where the provider publishes one; the others fall back to infrared.</p>" : ""}
      ${live ? `<table><thead><tr><th>Satellite</th><th>Product</th><th>Image time</th><th>Served by</th></tr></thead><tbody>${satRows}</tbody></table>
        <p>Each satellite is shown only in its own longitude band (seams halfway between neighbours). Areas beyond about 81° N/S are outside geostationary view.</p>`
        : "<p>Live satellite layer is off.</p>"}
      <h3>Other layers</h3>
      <ul>${STATIC_SOURCES.map(([what, who, url]) => `<li>${escapeHtml(what)}: ${link(url, who)}</li>`).join("")}
      <li>Day/night line: calculated from the sun's position (no download)</li></ul>
      ${newsState.data ? `<h3>News &amp; videos</h3><ul>${newsState.data.sources.map((src) =>
        `<li><span class="dot ${src.ok ? "ok" : "guess"}"></span>${link(src.url, src.name)}${src.ok ? ` (${src.count})` : " (unavailable)"}</li>`).join("")}</ul>` : ""}
      <h3>El Niño</h3>
      ${ensoSources ? `<ul>${ensoSources}</ul>` : "<p>El Niño data has not loaded.</p>"}`;
  }

  $("sources-btn").addEventListener("click", () => { renderSources(); $("sources-panel").hidden = false; });
  $("sources-close").addEventListener("click", () => { $("sources-panel").hidden = true; });

  // ------------------------------------------------------------------
  // El Niño: SST anomaly map + Niño regions + NOAA status
  // ------------------------------------------------------------------
  const enso = { data: null, tiles: null, group: L.layerGroup(), boxes: {}, sstOn: true };
  const signed = (v, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
  const regionColor = (a) => (a >= 0.5 ? "#ff5a3c" : a <= -0.5 ? "#4d8dff" : "#ffffff");
  const regionLabel = (r) => `${r.name} ${signed(r.anomaly)}°C ${r.change_4w >= 0 ? "▲" : "▼"}`;

  function sparkline(values) {
    const w = 100, h = 24, max = Math.max(1, ...values.map(Math.abs));
    const y = (v) => h / 2 - (v / max) * (h / 2 - 2);
    const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${y(v).toFixed(1)}`).join(" ");
    const last = values[values.length - 1];
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="rgba(255,255,255,.2)" />
      <polyline points="${pts}" fill="none" stroke="${last >= 0 ? "#ff7a6b" : "#6ba8ff"}" stroke-width="1.6" /></svg>`;
  }

  function renderEnso(d) {
    const rows = d.regions.map((r) => `
      <div class="enso-row ${r.id === d.focus.id ? "focus" : ""}" data-region="${r.id}" title="${escapeHtml(r.about)}">
        <span>${escapeHtml(r.name)}</span>
        <span class="anom ${r.anomaly >= 0 ? "warm" : "cool"}">${signed(r.anomaly)}°</span>
        ${sparkline(r.history)}
        <span class="chg ${r.change_4w >= 0 ? "warm" : "cool"}">${r.change_4w >= 0 ? "▲" : "▼"} ${Math.abs(r.change_4w).toFixed(1)}</span>
      </div>`).join("");
    const oni = d.oni.map((o) => `<span class="${o.anomaly >= 0 ? "warm" : "cool"}">${o.season} ${o.year}: ${signed(o.anomaly)}</span>`).join("");
    $("enso-content").innerHTML = `
      <span class="enso-phase ${d.phase}">${d.phase === "el_nino" ? "El Niño" : d.phase === "la_nina" ? "La Niña" : "Neutral"}</span>
      <div class="enso-headline">${escapeHtml(d.headline)}</div>
      <div><span class="enso-big ${d.nino34_anomaly >= 0 ? "warm" : "cool"}">${signed(d.nino34_anomaly)} °C</span>
        Niño 3.4, week of ${escapeHtml(new Date(`${d.week}T12:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }))}
        <br><small>${d.trend_4w >= 0 ? "▲" : "▼"} ${signed(d.trend_4w)} °C in the last 4 weeks</small></div>
      <div class="enso-focus">🎯 ${escapeHtml(d.focus.text)}</div>
      <div class="section-title">Niño regions · anomaly · last 12 weeks · 4-week change</div>
      ${rows}
      ${oni ? `<div class="section-title">Oceanic Niño Index (official, 3-month)</div><div class="enso-oni">${oni}</div>` : ""}
      <div class="enso-note">${escapeHtml(d.note)} Map: daily sea temperature anomaly for ${escapeHtml(d.sst_layer.date)}.
        <a href="#" id="enso-sources" style="color:var(--accent)">Sources</a></div>`;
    $("enso-content").querySelectorAll(".enso-row").forEach((row) => {
      row.addEventListener("click", () => focusRegion(row.dataset.region));
    });
    $("enso-sources").addEventListener("click", (e) => { e.preventDefault(); $("sources-btn").click(); });
  }

  function focusRegion(id) {
    const r = enso.data && enso.data.regions.find((x) => x.id === id);
    if (!r) return;
    if (globe.active && globe.map) {
      globe.map.flyTo({ center: [(r.west + r.east) / 2, (r.south + r.north) / 2], zoom: 3.6, duration: 1500 });
    } else {
      map.flyToBounds([[r.south, r.west], [r.north, r.east]], { padding: [80, 80], duration: 1.2 });
    }
  }

  function drawEnsoOnMap(d) {
    if (enso.tiles) map.removeLayer(enso.tiles);
    enso.tiles = L.tileLayer(d.sst_layer.url, {
      pane: "sst", opacity: 0.8, maxNativeZoom: d.sst_layer.max_native_zoom, maxZoom: 12,
      attribution: d.sst_layer.attribution,
    });
    if (enso.sstOn) enso.tiles.addTo(map);
    enso.group.clearLayers();
    enso.boxes = {};
    d.regions.forEach((r) => {
      const isFocus = r.id === d.focus.id;
      const color = regionColor(r.anomaly);
      // Draw each box in three world copies so it shows wherever the map is panned.
      [-360, 0, 360].forEach((off) => {
        const box = L.rectangle([[r.south, r.west + off], [r.north, r.east + off]], {
          color, weight: isFocus ? 3 : 1.5, dashArray: isFocus ? null : "5 5",
          fillColor: color, fillOpacity: isFocus ? 0.12 : 0.04,
          className: isFocus ? "enso-focus-box" : "",
        }).bindTooltip(regionLabel(r), { permanent: true, direction: "center", className: "enso-label" })
          .on("click", () => focusRegion(r.id))
          .addTo(enso.group);
        if (off === 0) enso.boxes[r.id] = box;
      });
    });
    enso.group.addTo(map);
  }

  async function loadEnso() {
    try {
      const d = await api("/api/enso");
      enso.data = d;
      renderEnso(d);
      drawEnsoOnMap(d);
      updateGlobeEnso();
      if (!$("sources-panel").hidden) renderSources();
    } catch (err) {
      $("enso-content").innerHTML = `<div class="enso-headline">El Niño data is unavailable</div>
        <p>${escapeHtml(err.message)}</p>`;
      toast(`El Niño: ${err.message}`);
    }
  }

  $("sst-toggle").addEventListener("click", () => {
    enso.sstOn = !enso.sstOn;
    $("sst-toggle").classList.toggle("active", enso.sstOn);
    $("legend").hidden = !enso.sstOn;
    if (enso.tiles) {
      if (enso.sstOn) enso.tiles.addTo(map); else map.removeLayer(enso.tiles);
    }
    updateGlobeEnso();
  });
  // NOAA updates weekly and the SST map daily; refresh a few times a day.
  setInterval(loadEnso, 6 * 3600 * 1000);

  // ------------------------------------------------------------------
  // 3D globe (MapLibre GL, loaded on first use)
  // ------------------------------------------------------------------
  const MAPLIBRE = {
    js: "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js",
    jsSri: "sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp",
    css: "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css",
    cssSri: "sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK",
  };

  // `ready` is set on the style's load event. (map.isStyleLoaded() stays false
  // while any tiles are loading, so it can't be used to gate layer updates.)
  const globe = { map: null, ready: false, active: false, satIds: [], markers: [], loading: null };

  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    if (globe.loading) return globe.loading;
    globe.loading = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      Object.assign(css, { rel: "stylesheet", href: MAPLIBRE.css, integrity: MAPLIBRE.cssSri, crossOrigin: "" });
      document.head.appendChild(css);
      const js = document.createElement("script");
      Object.assign(js, { src: MAPLIBRE.js, integrity: MAPLIBRE.jsSri, crossOrigin: "" });
      js.onload = resolve;
      js.onerror = () => { globe.loading = null; reject(new Error("Could not load the 3D globe library.")); };
      document.head.appendChild(js);
    });
    return globe.loading;
  }

  // Night side as a GeoJSON polygon (lon/lat order, within -180..180).
  function nightGeoJSON(date) {
    const rad = Math.PI / 180;
    const sun = sunPosition(date);
    let dec = sun.lat * rad;
    if (Math.abs(dec) < 0.001) dec = 0.001;
    const ring = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      ring.push([lon, Math.atan(-Math.cos((lon - sun.lon) * rad) / Math.tan(dec)) / rad]);
    }
    const pole = dec > 0 ? -89.9 : 89.9;
    ring.push([180, pole], [-180, pole], ring[0]);
    return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
  }

  // MapLibre bounds must stay within -180..180, so split bands that cross it.
  function splitBand([w, e]) {
    if (e > 180) return [[w, 180], [-180, e - 360]];
    if (w < -180) return [[w + 360, 180], [-180, e]];
    return [[w, e]];
  }

  function globeSatelliteTiles(sat) {
    if (sat.type === "wms") {
      const q = new URLSearchParams({
        service: "WMS", request: "GetMap", layers: sat.layer, styles: "", format: "image/png",
        transparent: "true", version: "1.3.0", width: "256", height: "256", crs: "EPSG:3857",
      });
      return [`${sat.url}?${q}&bbox={bbox-epsg-3857}`];
    }
    return [sat.url];
  }

  function updateGlobeSatellites() {
    const gm = globe.map;
    if (!gm || !globe.ready) return;
    globe.satIds.forEach((id) => { if (gm.getLayer(id)) gm.removeLayer(id); if (gm.getSource(id)) gm.removeSource(id); });
    globe.satIds = [];
    const data = clouds.data;
    if (!data) return;
    data.layers.forEach((sat) => {
      splitBand(sat.band).forEach(([w, e], i) => {
        const id = `sat-${sat.id}-${i}`;
        gm.addSource(id, {
          type: "raster", tiles: globeSatelliteTiles(sat), tileSize: 256,
          maxzoom: sat.max_native_zoom, bounds: [w, -SAT_LAT_LIMIT, e, SAT_LAT_LIMIT],
          attribution: sat.attribution,
        });
        gm.addLayer({
          id, type: "raster", source: id,
          paint: { "raster-opacity": sat.style === "infrared" ? 0.65 : 1, "raster-fade-duration": 0 },
        }, "night");
        globe.satIds.push(id);
      });
    });
  }

  function updateGlobeNight() {
    const gm = globe.map;
    if (!gm || !gm.getSource("night")) return;
    gm.getSource("night").setData(night.on ? nightGeoJSON(new Date())
      : { type: "FeatureCollection", features: [] });
  }

  // Niño regions as GeoJSON (MapLibre wants longitudes within -180..180).
  function regionsGeoJSON(d) {
    const features = [];
    d.regions.forEach((r) => {
      splitBand([r.west, r.east]).forEach(([w, e]) => {
        features.push({
          type: "Feature",
          properties: { id: r.id, focus: r.id === d.focus.id, color: regionColor(r.anomaly) },
          geometry: { type: "Polygon", coordinates: [[[w, r.south], [e, r.south], [e, r.north], [w, r.north], [w, r.south]]] },
        });
      });
    });
    return { type: "FeatureCollection", features };
  }

  function updateGlobeEnso() {
    const gm = globe.map;
    const d = enso.data;
    if (!gm || !globe.ready || !d) return;
    ["sst", "regions-fill", "regions-line"].forEach((id) => { if (gm.getLayer(id)) gm.removeLayer(id); });
    ["sst", "regions"].forEach((id) => { if (gm.getSource(id)) gm.removeSource(id); });
    globe.markers.forEach((m) => m.remove());
    globe.markers = [];

    if (enso.sstOn) {
      gm.addSource("sst", {
        type: "raster", tiles: [d.sst_layer.url], tileSize: 256, maxzoom: d.sst_layer.max_native_zoom,
        attribution: d.sst_layer.attribution,
      });
      gm.addLayer({ id: "sst", type: "raster", source: "sst", paint: { "raster-opacity": 0.8 } }, "night");
    }
    gm.addSource("regions", { type: "geojson", data: regionsGeoJSON(d) });
    gm.addLayer({
      id: "regions-fill", type: "fill", source: "regions",
      paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["get", "focus"], 0.15, 0.05] },
    });
    gm.addLayer({
      id: "regions-line", type: "line", source: "regions",
      paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "focus"], 3, 1.5] },
    });
    // Labels as HTML markers (no font server needed).
    d.regions.forEach((r) => {
      const el = document.createElement("div");
      el.className = "enso-label globe-label";
      el.textContent = regionLabel(r);
      el.addEventListener("click", (e) => { e.stopPropagation(); focusRegion(r.id); });
      const lon = (((r.west + r.east) / 2 + 540) % 360) - 180;
      globe.markers.push(new maplibregl.Marker({ element: el })
        .setLngLat([lon, (r.south + r.north) / 2]).addTo(gm));
    });
  }

  async function createGlobe() {
    await loadMapLibre();
    const gm = new maplibregl.Map({
      container: "globe",
      center: [-140, 0], // the equatorial Pacific
      zoom: 2,
      maxZoom: 12,
      attributionControl: { compact: true },
      style: {
        version: 8,
        projection: { type: "globe" },
        sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] },
        sources: {
          imagery: {
            type: "raster", tileSize: 256, maxzoom: 19,
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
          },
          labels: {
            type: "raster", tileSize: 256, maxzoom: 16,
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
          },
          night: { type: "geojson", data: nightGeoJSON(new Date()) },
        },
        layers: [
          { id: "space", type: "background", paint: { "background-color": "#02040a" } },
          { id: "imagery", type: "raster", source: "imagery" },
          { id: "night", type: "fill", source: "night", paint: { "fill-color": "#000814", "fill-opacity": 0.4 } },
          { id: "labels", type: "raster", source: "labels" },
        ],
      },
    });
    gm.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-left");
    gm.on("load", () => {
      globe.ready = true;
      updateGlobeSatellites();
      updateGlobeNight();
      updateGlobeEnso();
    });
    globe.map = gm;
  }

  async function showGlobe() {
    globe.active = true;
    document.body.classList.add("globe-mode");
    $("globe").hidden = false;
    $("globe-toggle").classList.add("active");
    $("map-toggle").classList.remove("active");
    try {
      if (!globe.map) await createGlobe();
      else {
        const c = map.getCenter();
        globe.map.resize();
        globe.map.jumpTo({ center: [((c.lng + 540) % 360) - 180, clamp(c.lat, -60, 60)], zoom: 2 });
        updateGlobeSatellites();
        updateGlobeNight();
      }
    } catch (err) {
      toast(err.message);
      hideGlobe();
    }
  }

  function hideGlobe() {
    if (!globe.active) return;
    globe.active = false;
    document.body.classList.remove("globe-mode");
    $("globe").hidden = true;
    $("globe-toggle").classList.remove("active");
    $("map-toggle").classList.add("active");
    map.invalidateSize();
  }

  $("globe-toggle").addEventListener("click", showGlobe);
  $("map-toggle").addEventListener("click", hideGlobe);

  // ------------------------------------------------------------------
  // El Niño news and videos
  // ------------------------------------------------------------------
  const newsState = { data: null, loadedAt: 0, tab: "articles" };
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

  function timeAgo(iso) {
    if (!iso) return "";
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 60) return `${Math.max(mins, 1)} min ago`;
    if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
    return `${Math.round(mins / 1440)} days ago`;
  }

  function fillSelect(select, values, label) {
    const counts = {};
    values.filter(Boolean).forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
    const current = select.value;
    select.innerHTML = `<option value="">${label}</option>` + Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([v, n]) => `<option value="${escapeHtml(v)}">${escapeHtml(v)} (${n})</option>`).join("");
    if (counts[current]) select.value = current;
  }

  function renderArticles() {
    const d = newsState.data;
    const country = $("news-country").value;
    const language = $("news-language").value;
    const items = d.articles.filter((a) => (!country || a.country === country) && (!language || a.language === language));
    if (!items.length) {
      $("news-body").innerHTML = '<p class="muted">No El Niño news for this selection right now.</p>';
      return;
    }
    $("news-body").innerHTML = items.map((a) => {
      const url = safeUrl(a.url);
      if (!url) return "";
      const img = safeUrl(a.image);
      return `<a class="news-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
        ${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        <div><div class="news-title">${escapeHtml(a.title)}</div>
          <div class="news-meta">${a.country ? `<span class="flag">${escapeHtml(a.country)}</span>` : ""}${escapeHtml(a.source)}
            ${a.language ? ` · ${escapeHtml(a.language)}` : ""}${a.published ? ` · ${escapeHtml(timeAgo(a.published))}` : ""}</div></div>
      </a>`;
    }).join("");
  }

  function renderVideos() {
    const d = newsState.data;
    const videos = d.videos.filter((v) => VIDEO_ID.test(v.id));
    const latest = videos.filter((v) => !v.explainer);
    const card = (v) => `<button class="video-card" data-id="${v.id}" data-title="${escapeHtml(v.title)}">
        <span class="thumb"><img src="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" alt="" loading="lazy"></span>
        <div class="vt">${escapeHtml(v.title)}</div>
        <div class="vm">${escapeHtml(v.channel)}${v.published ? ` · ${escapeHtml(timeAgo(v.published))}` : ""}</div>
      </button>`;
    const search = safeUrl(d.youtube_search);
    $("news-body").innerHTML = `
      ${search ? `<a class="yt-search" href="${escapeHtml(search)}" target="_blank" rel="noopener noreferrer">▶ Search all El Niño videos on YouTube</a>` : ""}
      <div class="section-title">Latest from weather &amp; climate agencies</div>
      ${latest.length ? `<div class="video-grid">${latest.map(card).join("")}</div>`
        : '<p class="muted">No new El Niño videos from NOAA, NASA, WMO, the Met Office or the Bureau of Meteorology in their latest uploads.</p>'}
      <div class="section-title">Explainers</div>
      <div class="video-grid">${videos.filter((v) => v.explainer).map(card).join("")}</div>`;
    $("news-body").querySelectorAll(".video-card").forEach((btn) => {
      btn.addEventListener("click", () => playVideo(btn.dataset.id, btn.dataset.title));
    });
  }

  function renderNews() {
    const d = newsState.data;
    if (!d) return;
    $("news-filters").hidden = newsState.tab !== "articles";
    document.querySelectorAll(".news-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === newsState.tab));
    if (newsState.tab === "articles") renderArticles(); else renderVideos();
    const ok = d.sources.filter((src) => src.ok).length;
    $("news-foot").innerHTML = `${d.articles.length} articles · ${d.videos.length} videos from ${ok} free sources
      · updated ${escapeHtml(timeAgo(d.updated))} · <a href="#" id="news-sources">Sources</a>`;
    $("news-sources").addEventListener("click", (e) => { e.preventDefault(); $("sources-btn").click(); });
  }

  async function loadNews() {
    try {
      const d = await api("/api/news");
      newsState.data = d;
      newsState.loadedAt = Date.now();
      fillSelect($("news-country"), d.articles.map((a) => a.country), "All countries");
      fillSelect($("news-language"), d.articles.map((a) => a.language), "All languages");
      renderNews();
      if (!$("sources-panel").hidden) renderSources();
    } catch (err) {
      $("news-body").innerHTML = `<p class="muted">News is unavailable right now: ${escapeHtml(err.message)}</p>`;
    }
  }

  function playVideo(id, title) {
    if (!VIDEO_ID.test(id)) return;
    $("video-frame").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0"
      title="${escapeHtml(title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
    $("video-title").textContent = title;
    $("video-modal").hidden = false;
  }

  function closeVideo() {
    $("video-frame").innerHTML = ""; // stops playback
    $("video-modal").hidden = true;
  }

  // News and Learn open in the same spot, so only one is shown at a time.
  function setSidePanel(name) {
    ["news", "learn"].forEach((p) => {
      $(`${p}-panel`).hidden = p !== name;
      $(`${p}-toggle`).classList.toggle("active", p === name);
    });
    if (name === "news" && Date.now() - newsState.loadedAt > 30 * 60 * 1000) loadNews();
  }
  $("news-toggle").addEventListener("click", () => setSidePanel($("news-panel").hidden ? "news" : null));
  $("learn-toggle").addEventListener("click", () => setSidePanel($("learn-panel").hidden ? "learn" : null));
  $("news-close").addEventListener("click", () => setSidePanel(null));
  $("learn-close").addEventListener("click", () => setSidePanel(null));
  document.querySelectorAll(".news-tab").forEach((tab) => {
    tab.addEventListener("click", () => { newsState.tab = tab.dataset.tab; renderNews(); });
  });
  $("news-country").addEventListener("change", renderArticles);
  $("news-language").addEventListener("change", renderArticles);
  $("video-close").addEventListener("click", closeVideo);
  $("video-modal").addEventListener("click", (e) => { if (e.target === $("video-modal")) closeVideo(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("video-modal").hidden) closeVideo(); });

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  $("legend").hidden = false;
  loadClouds();
  updateNight();
  loadEnso();
  // Open on the globe unless the link points at a specific map view.
  if (linkedView) $("map-toggle").classList.add("active"); else showGlobe();
})();
