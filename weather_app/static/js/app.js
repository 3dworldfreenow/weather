/* El Niño Tracker front-end.
   Live Earth (Leaflet map + MapLibre 3D globe) with the Pacific sea temperature
   anomaly and Niño regions, plus a tabbed panel: Status, Impacts, News, History, Learn.
   On phones the panel is a draggable bottom sheet; on wide screens a side panel. */
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
  const PACIFIC = [[-25, -215], [25, -70]];
  const IMPACTS = JSON.parse($("impacts-data").textContent);
  const IMPACT_BY_SLUG = Object.fromEntries(IMPACTS.countries.map((c) => [c.slug, c]));

  const map = L.map("map", {
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: true,
    zoomControl: false,
    keyboard: false,
  });
  map.fitBounds(PACIFIC);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  map.createPane("impacts").style.zIndex = 340;
  map.createPane("sst").style.zIndex = 350;
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
      ${newsState.data ? `<h3>News &amp; videos</h3>
        <p>${newsState.data.sources.filter((src) => src.ok).length} of ${newsState.data.sources.length} free sources working:
          Google News, Bing News, GDELT, newspapers in ${new Set(newsState.data.sources.filter((src) => src.kind === "publisher" && src.ok)
            .map((src) => (src.name.match(/\(([^)]+)\)$/) || [])[1]).filter(Boolean)).size} countries, UN and NGO reports,
          science feeds, research papers, podcasts and agency video channels.
          <a href="news/#sources">See every source on the News page</a>.</p>` : ""}
      <h3>Country impacts</h3>
      <ul>${IMPACTS.sources.map((src) => `<li>${link(src.url, src.name)}</li>`).join("")}
        <li>National weather services, linked on each country's card</li></ul>
      <h3>El Niño</h3>
      ${ensoSources ? `<ul>${ensoSources}</ul>` : "<p>El Niño data has not loaded.</p>"}`;
  }

  $("sources-btn").addEventListener("click", () => { renderSources(); $("sources-panel").hidden = false; });
  $("sources-close").addEventListener("click", () => { $("sources-panel").hidden = true; });


  // ------------------------------------------------------------------
  // Panel: bottom sheet on phones, side panel on wide screens
  // ------------------------------------------------------------------
  const sheetEl = $("sheet");
  const root = document.documentElement;
  const mqPhone = window.matchMedia("(max-width: 899px)");
  const mqPhoneLandscape = window.matchMedia("(max-width: 899px) and (orientation: landscape) and (max-height: 520px)");
  const isSheetMode = () => mqPhone.matches && !mqPhoneLandscape.matches;
  const SHEET_STATES = ["peek", "half", "full"];
  const sheet = { state: "half", visible: 0 };

  function sheetVisible(state) {
    const full = sheetEl.offsetHeight;
    if (state === "full") return full;
    if (state === "peek") return Math.min(full, 112);
    return Math.min(full, Math.round(window.innerHeight * 0.48));
  }

  // Space the map should keep clear of the panels, in CSS pixels.
  function viewPadding() {
    const top = (document.querySelector(".topbar").getBoundingClientRect().bottom || 64) + 8;
    if (isSheetMode()) return { top, bottom: sheet.visible + 8, left: 8, right: 8 };
    const r = sheetEl.getBoundingClientRect();
    return { top, bottom: 16, left: r.right + 12, right: 16 };
  }

  function applySheet(visible) {
    if (!isSheetMode()) {
      sheet.visible = 0;
      sheetEl.style.removeProperty("--sheet-offset");
      root.style.removeProperty("--sheet-h");
      document.body.classList.remove("sheet-full");
    } else {
      const full = sheetEl.offsetHeight;
      sheet.visible = clamp(visible, 0, full);
      sheetEl.style.setProperty("--sheet-offset", `${full - sheet.visible}px`);
      root.style.setProperty("--sheet-h", `${sheet.visible}px`);
      document.body.classList.toggle("sheet-full", sheet.visible >= full - 2);
    }
    updateGlobePadding();
  }

  function setSheetState(state) {
    sheet.state = state;
    sheetEl.dataset.state = state;
    $("sheet-handle").setAttribute("aria-label", state === "full" ? "Collapse the panel" : "Expand the panel");
    applySheet(sheetVisible(state));
  }

  // Drag the handle or the tab bar to resize; tap the handle to cycle sizes.
  // Moves are tracked on the window, so the finger can leave the thin handle.
  (() => {
    let drag = null;
    let suppressClick = false;
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dy) < 8) return;
      if (!drag.moved) { drag.moved = true; sheetEl.classList.add("dragging"); }
      e.preventDefault();
      applySheet(drag.visible - dy);
    };
    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      sheetEl.classList.remove("dragging");
      if (!d.moved) {
        if (d.target === $("sheet-handle")) {
          setSheetState(SHEET_STATES[(SHEET_STATES.indexOf(sheet.state) + 1) % SHEET_STATES.length]);
        }
        return;
      }
      suppressClick = true; // the drag must not also press a tab
      setTimeout(() => { suppressClick = false; }, 0);
      // Snap to the nearest size, nudged by the flick direction.
      const velocity = (d.y - e.clientY) / Math.max(1, performance.now() - d.t); // px/ms, + = up
      const target = sheet.visible + clamp(velocity, -2, 2) * 200;
      const best = SHEET_STATES.reduce((a, b) =>
        (Math.abs(sheetVisible(b) - target) < Math.abs(sheetVisible(a) - target) ? b : a));
      setSheetState(best);
    };
    const onDown = (e) => {
      if (!isSheetMode() || (e.button !== undefined && e.button !== 0)) return;
      drag = { y: e.clientY, visible: sheet.visible, t: performance.now(), moved: false, target: e.currentTarget, id: e.pointerId };
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };
    $("sheet-handle").addEventListener("pointerdown", onDown);
    document.querySelector(".tabs").addEventListener("pointerdown", onDown);
    document.querySelector(".tabs").addEventListener("click", (e) => {
      if (suppressClick) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  })();

  const relayout = () => { applySheet(sheetVisible(sheet.state)); map.invalidateSize(); if (globe.map) globe.map.resize(); };
  window.addEventListener("resize", relayout);
  mqPhone.addEventListener("change", relayout);
  mqPhoneLandscape.addEventListener("change", relayout);

  // ------------------------------------------------------------------
  // Tabs and links (#impact=peru, #tab=news)
  // ------------------------------------------------------------------
  const TABS = ["status", "impacts", "news", "history", "learn"];
  const ui = { tab: "status" };

  function setTab(name, { expand = true } = {}) {
    if (!TABS.includes(name)) return;
    ui.tab = name;
    TABS.forEach((t) => {
      $(`tab-${t}`).hidden = t !== name;
      $(`tab-btn-${t}`).setAttribute("aria-selected", String(t === name));
    });
    $("sheet-body").scrollTop = 0;
    if (expand && isSheetMode() && sheet.state === "peek") setSheetState("half");
    if (name === "impacts") setImpactsLayer(true);
    if (name === "news" && Date.now() - newsState.loadedAt > 30 * 60 * 1000) loadNews();
    if (name === "history") renderHistory();
    if (name !== "impacts" || !impactsState.selected) setHash(name === "status" ? "" : `tab=${name}`);
  }

  function setHash(value) {
    history.replaceState(null, "", value ? `#${value}` : window.location.pathname + window.location.search);
  }

  document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => setTab(btn.dataset.tab)));

  function routeFromHash() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.get("impact") && IMPACT_BY_SLUG[params.get("impact")]) {
      setTab("impacts");
      selectCountry(params.get("impact"), { fly: true });
    } else if (params.get("tab")) {
      setTab(params.get("tab"));
    }
  }
  window.addEventListener("hashchange", routeFromHash);

  // ------------------------------------------------------------------
  // Layers menu
  // ------------------------------------------------------------------
  function setLayersOpen(open) {
    $("layers-pop").hidden = !open;
    $("layers-btn").setAttribute("aria-expanded", String(open));
  }
  $("layers-btn").addEventListener("click", (e) => { e.stopPropagation(); setLayersOpen($("layers-pop").hidden); });
  $("layers-close").addEventListener("click", () => setLayersOpen(false));
  document.addEventListener("click", (e) => {
    if (!$("layers-pop").hidden && !$("layers-pop").contains(e.target) && e.target !== $("layers-btn")) setLayersOpen(false);
  });

  // ------------------------------------------------------------------
  // El Niño status: SST anomaly map + Niño regions + NOAA numbers
  // ------------------------------------------------------------------
  const enso = { data: null, tiles: null, group: L.layerGroup(), boxes: {}, sstOn: true };
  const signed = (v, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
  const regionColor = (a) => (a >= 0.5 ? "#ff5a3c" : a <= -0.5 ? "#4d8dff" : "#ffffff");
  const regionLabel = (r) => (isSheetMode()
    ? `${r.name.replace("Niño ", "")} ${signed(r.anomaly)}°`
    : `${r.name} ${signed(r.anomaly)}°C ${r.change_4w >= 0 ? "▲" : "▼"}`);
  const fmtWeek = (iso) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

  function sparkline(values) {
    const w = 100, h = 24, max = Math.max(1, ...values.map(Math.abs));
    const y = (v) => h / 2 - (v / max) * (h / 2 - 2);
    const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${y(v).toFixed(1)}`).join(" ");
    const last = values[values.length - 1];
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="rgba(60,64,67,.25)" />
      <polyline points="${pts}" fill="none" stroke="${last >= 0 ? "#d93025" : "#1a73e8"}" stroke-width="1.6" /></svg>`;
  }

  function renderEnso(d) {
    const rows = d.regions.map((r) => `
      <button class="enso-row ${r.id === d.focus.id ? "focus" : ""}" data-region="${r.id}" title="${escapeHtml(r.about)}">
        <span>${escapeHtml(r.name)}</span>
        <span class="anom ${r.anomaly >= 0 ? "warm" : "cool"}">${signed(r.anomaly)}°</span>
        ${sparkline(r.history)}
        <span class="chg ${r.change_4w >= 0 ? "warm" : "cool"}">${r.change_4w >= 0 ? "▲" : "▼"} ${Math.abs(r.change_4w).toFixed(1)}</span>
      </button>`).join("");
    const oni = d.oni.map((o) => `<span class="${o.anomaly >= 0 ? "warm" : "cool"}">${o.season} ${o.year}: ${signed(o.anomaly)}</span>`).join("");
    $("enso-content").innerHTML = `
      <span class="enso-phase ${d.phase}">${d.phase === "el_nino" ? "El Niño" : d.phase === "la_nina" ? "La Niña" : "Neutral"}</span>
      <h2 class="enso-headline">${escapeHtml(d.headline)}</h2>
      <p><span class="enso-big ${d.nino34_anomaly >= 0 ? "warm" : "cool"}">${signed(d.nino34_anomaly)} °C</span>
        Niño 3.4, week of ${escapeHtml(fmtWeek(d.week))}
        <br><small>${d.trend_4w >= 0 ? "▲" : "▼"} ${signed(d.trend_4w)} °C in the last 4 weeks</small></p>
      <p class="enso-focus">🎯 ${escapeHtml(d.focus.text)}</p>
      <h3 class="section-title">Niño regions · anomaly · 12 weeks · 4-week change</h3>
      ${rows}
      ${oni ? `<h3 class="section-title">Oceanic Niño Index (official, 3-month)</h3><div class="enso-oni">${oni}</div>` : ""}
      <p class="enso-note">${escapeHtml(d.note)} Map: daily sea temperature anomaly for ${escapeHtml(d.sst_layer.date)}.
        <button class="link-btn" id="enso-sources">Sources</button></p>`;
    $("enso-content").querySelectorAll(".enso-row").forEach((row) => {
      row.addEventListener("click", () => focusRegion(row.dataset.region));
    });
    $("enso-sources").addEventListener("click", () => $("sources-btn").click());
  }

  // Fly so that a lat/lon box is visible in the free space around the panels.
  function flyToBox(south, west, north, east, globeZoom = 3.4) {
    const p = viewPadding();
    if (globe.active && globe.map) {
      globe.map.flyTo({ center: [(((west + east) / 2 + 540) % 360) - 180, (south + north) / 2], zoom: globeZoom, padding: p, duration: 1400 });
    } else {
      map.flyToBounds([[south, west], [north, east]], {
        paddingTopLeft: [p.left + 16, p.top + 16], paddingBottomRight: [p.right + 16, p.bottom + 16], duration: 1.2, maxZoom: 6,
      });
    }
  }

  function focusRegion(id) {
    const r = enso.data && enso.data.regions.find((x) => x.id === id);
    if (!r) return;
    if (isSheetMode() && sheet.state === "full") setSheetState("half");
    flyToBox(r.south, r.west, r.north, r.east, 3.6);
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
          pane: "sst", color, weight: isFocus ? 3 : 1.5, dashArray: isFocus ? null : "5 5",
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
      if (ui.tab === "history") renderHistory();
      if (!$("sources-panel").hidden) renderSources();
    } catch (err) {
      $("enso-content").innerHTML = `<h2 class="enso-headline">El Niño data is unavailable</h2>
        <p class="muted">${escapeHtml(err.message)}</p>`;
    }
  }

  function updateLegend() {
    const parts = [];
    if (enso.sstOn) {
      parts.push(`<div class="legend-title">Sea temperature vs normal (°C)</div>
        <div class="legend-bar sst-gradient"></div>
        <div class="legend-labels"><span>−3</span><span>−2</span><span>−1</span><span>0</span><span>+1</span><span>+2</span><span>+3</span></div>`);
    }
    if (impactsState.on) {
      parts.push(`<div class="legend-title" style="margin-top:${parts.length ? 6 : 0}px">Typical El Niño effect</div>
        <div class="legend-effects">${Object.values(IMPACTS.effects).map((e) =>
          `<span><i style="background:${e.color}"></i>${escapeHtml(e.label.split(/[:/]/)[0].trim())}</span>`).join("")}</div>`);
    }
    $("legend").innerHTML = parts.join("");
    $("legend").hidden = !parts.length;
  }

  $("sst-toggle").addEventListener("change", (e) => {
    enso.sstOn = e.target.checked;
    if (enso.tiles) { if (enso.sstOn) enso.tiles.addTo(map); else map.removeLayer(enso.tiles); }
    updateGlobeEnso();
    updateLegend();
  });
  // NOAA updates weekly and the SST map daily; refresh a few times a day.
  setInterval(loadEnso, 6 * 3600 * 1000);

  // ------------------------------------------------------------------
  // Impacts: typical El Niño effects by country (map, globe and panel)
  // ------------------------------------------------------------------
  const impactsState = { on: false, geo: null, layer: L.layerGroup(), selected: null, loading: null };
  const effectColor = (effect) => IMPACTS.effects[effect].color;
  const SLUG_BY_SHAPE = {};
  IMPACTS.countries.forEach((c) => {
    c.map_ids.forEach((id) => { SLUG_BY_SHAPE[`id:${id}`] = c.slug; });
    c.map_names.forEach((n) => { SLUG_BY_SHAPE[`name:${n}`] = c.slug; });
  });
  const slugForFeature = (f) => SLUG_BY_SHAPE[`id:${f.properties.id}`] || SLUG_BY_SHAPE[`name:${f.properties.name}`];
  // Countries too small for the world shapes (e.g. Kiribati) are drawn as dots.
  const POINT_COUNTRIES = IMPACTS.countries.filter((c) => !c.map_ids.length && !c.map_names.length);
  const staticUrl = (path) => {
    const css = document.querySelector('link[rel="stylesheet"][href*="css/style.css"]');
    return new URL(path, css ? css.href.replace(/css\/style\.css.*$/, "") : `${window.location.origin}/static/`).href;
  };

  function loadCountryShapes() {
    if (!impactsState.loading) {
      impactsState.loading = fetch(staticUrl("data/countries.geojson"))
        .then((r) => { if (!r.ok) throw new Error(`Country shapes unavailable (${r.status})`); return r.json(); })
        .then((geo) => {
          geo.features = geo.features.filter((f) => {
            const slug = slugForFeature(f);
            if (slug) { f.properties.slug = slug; f.properties.color = effectColor(IMPACT_BY_SLUG[slug].effect); }
            return Boolean(slug);
          });
          impactsState.geo = geo;
          return geo;
        })
        .catch((err) => { impactsState.loading = null; throw err; });
    }
    return impactsState.loading;
  }

  async function drawImpactsOnMap() {
    const geo = await loadCountryShapes();
    impactsState.layer.clearLayers();
    [-360, 0, 360].forEach((off) => {
      L.geoJSON(geo, {
        pane: "impacts",
        coordsToLatLng: (c) => L.latLng(c[1], c[0] + off),
        style: (f) => ({
          color: f.properties.color, weight: f.properties.slug === impactsState.selected ? 3 : 1,
          opacity: 0.9, fillColor: f.properties.color, fillOpacity: f.properties.slug === impactsState.selected ? 0.65 : 0.42,
        }),
        onEachFeature: (f, layer) => {
          layer.bindTooltip(IMPACT_BY_SLUG[f.properties.slug].name, { sticky: true });
          layer.on("click", () => selectCountry(f.properties.slug, { fly: false }));
        },
      }).addTo(impactsState.layer);
      POINT_COUNTRIES.forEach((c) => {
        L.circleMarker([c.lat, c.lon + off], {
          pane: "impacts", radius: 9, color: "#fff", weight: 1.5, fillColor: effectColor(c.effect), fillOpacity: 0.9,
        }).bindTooltip(c.name).on("click", () => selectCountry(c.slug, { fly: false })).addTo(impactsState.layer);
      });
    });
  }

  async function setImpactsLayer(on) {
    impactsState.on = on;
    $("impacts-toggle").checked = on;
    updateLegend();
    try {
      if (on) {
        await drawImpactsOnMap();
        if (impactsState.on) impactsState.layer.addTo(map);
      } else {
        map.removeLayer(impactsState.layer);
      }
      updateGlobeImpacts();
    } catch (err) {
      toast(err.message);
    }
  }
  $("impacts-toggle").addEventListener("change", (e) => setImpactsLayer(e.target.checked));

  function countryNews(slug, limit = 5) {
    const d = newsState.data;
    if (!d) return [];
    return d.articles.filter((a) => (a.countries || []).includes(slug)).slice(0, limit);
  }

  function renderImpactDetail() {
    const c = IMPACT_BY_SLUG[impactsState.selected];
    if (!c) { $("impact-detail").innerHTML = ""; return; }
    const effect = IMPACTS.effects[c.effect];
    const news = countryNews(c.slug);
    const newsHtml = news.length ? news.map((a) => newsItemHtml(a)).join("")
      : `<p class="muted">${newsState.data ? "No recent El Niño headlines mention this country." : "Loading the latest news…"}</p>`;
    $("impact-detail").innerHTML = `
      <article class="impact-card" aria-live="polite">
        <button class="close-btn" id="impact-close" aria-label="Close">✕</button>
        <h3>El Niño in ${escapeHtml(c.name)}</h3>
        <span class="badge" style="background:${effect.color}">${escapeHtml(effect.label)}</span>
        <span class="season">${escapeHtml(c.season)}</span>
        <p>${escapeHtml(c.summary)}</p>
        ${c.details.length ? `<ul>${c.details.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
        ${c.past.length ? `<h4 class="section-title">Past El Niño events</h4><ul>${c.past.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}
        <h4 class="section-title">Latest El Niño news about ${escapeHtml(c.name)}</h4>
        ${newsHtml}
        <div class="actions">
          ${c.service ? `<a href="${escapeHtml(c.service.url)}" target="_blank" rel="noopener">Official forecasts: ${escapeHtml(c.service.name)} ↗</a>` : ""}
          <button class="link-btn" id="impact-all-news">All news about ${escapeHtml(c.name)} →</button>
          <a href="impacts/${encodeURIComponent(c.slug)}/">Full page ↗</a>
        </div>
      </article>`;
    $("impact-close").addEventListener("click", () => selectCountry(null));
    $("impact-all-news").addEventListener("click", () => {
      newsState.filters.country = `slug:${c.slug}`;
      newsState.filters.theme = "";
      setTab("news");
      renderNews();
    });
  }

  function countryBounds(slug) {
    const c = IMPACT_BY_SLUG[slug];
    const f = impactsState.geo && impactsState.geo.features.filter((x) => x.properties.slug === slug);
    if (!f || !f.length) return [c.lat - 6, c.lon - 8, c.lat + 6, c.lon + 8];
    const b = L.geoJSON({ type: "FeatureCollection", features: f }).getBounds();
    return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  }

  async function selectCountry(slug, { fly = true } = {}) {
    impactsState.selected = slug && IMPACT_BY_SLUG[slug] ? slug : null;
    document.querySelectorAll(".impact-row").forEach((r) => r.classList.toggle("selected", r.dataset.slug === impactsState.selected));
    renderImpactDetail();
    if (impactsState.on) { drawImpactsOnMap().catch(() => {}); updateGlobeImpacts(); }
    if (!impactsState.selected) { setHash("tab=impacts"); return; }
    setHash(`impact=${impactsState.selected}`);
    if (ui.tab === "impacts") $("sheet-body").scrollTop = 0;
    if (!newsState.data) loadNews().then(renderImpactDetail);
    if (fly) {
      try { await loadCountryShapes(); } catch (e) { /* fall back to the country's centre */ }
      const [s, w, n, e] = countryBounds(impactsState.selected);
      // Very wide countries (Russia/US across the date line) fall back to a centre view.
      if (e - w > 200) flyToBox(IMPACT_BY_SLUG[slug].lat - 10, IMPACT_BY_SLUG[slug].lon - 20, IMPACT_BY_SLUG[slug].lat + 10, IMPACT_BY_SLUG[slug].lon + 20, 2.8);
      else flyToBox(s, w, n, e, 3);
    }
  }

  document.querySelectorAll(".impact-row").forEach((row) => {
    row.addEventListener("click", (e) => { e.preventDefault(); selectCountry(row.dataset.slug); });
  });
  $("my-country").addEventListener("change", (e) => {
    if (!e.target.value) return;
    setTab("impacts");
    selectCountry(e.target.value);
    e.target.value = "";
  });
  $("impact-search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#impact-list .impact-list").forEach((list) => {
      let shown = 0;
      list.querySelectorAll("li").forEach((li) => {
        const c = IMPACT_BY_SLUG[li.firstElementChild.dataset.slug];
        const match = !q || c.name.toLowerCase().includes(q) || c.region.toLowerCase().includes(q);
        li.hidden = !match;
        if (match) shown += 1;
      });
      list.hidden = !shown;
      list.previousElementSibling.hidden = !shown;
    });
  });
  document.querySelectorAll(".theme-news").forEach((btn) => {
    btn.addEventListener("click", () => {
      newsState.filters.theme = btn.dataset.theme;
      newsState.filters.country = "";
      setTab("news");
      renderNews();
    });
  });

  // ------------------------------------------------------------------
  // History: NOAA Oceanic Niño Index since 1950 + episode table
  // ------------------------------------------------------------------
  const SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"];
  const historyState = { years: 0 };
  const svgNS = "http://www.w3.org/2000/svg";

  function renderEpisodes() {
    const d = enso.data;
    if (!d || !d.episodes) return;
    const showLaNina = $("show-la-nina").checked;
    const rows = d.episodes.filter((e) => showLaNina || e.phase === "el_nino").slice().reverse();
    const status = (e) => (e.ongoing && !e.confirmed ? " (developing)" : e.ongoing ? " (ongoing)" : "");
    $("episodes").innerHTML = `<table class="episodes">
      <thead><tr><th>Years</th><th>Phase</th><th>Peak ONI</th><th>Strength</th></tr></thead>
      <tbody>${rows.map((e) => `<tr class="${/strong/.test(e.strength) ? "strong" : ""}">
        <td>${escapeHtml(e.start)} – ${escapeHtml(e.end)}${status(e)}</td>
        <td class="${e.phase === "el_nino" ? "warm" : "cool"}">${e.phase === "el_nino" ? "El Niño" : "La Niña"}</td>
        <td>${signed(e.peak)} °C</td><td>${escapeHtml(e.strength)}</td></tr>`).join("")}</tbody></table>`;
  }

  function renderHistory() {
    const d = enso.data;
    const fig = $("oni-chart");
    if (!d || !d.oni_history || !d.oni_history.length) return;
    renderEpisodes();
    let pts = d.oni_history.map(([year, si, v]) => ({ x: year + (si + 0.5) / 12, v, label: `${SEASONS[si]} ${year}` }));
    if (historyState.years) {
      const cut = pts[pts.length - 1].x - historyState.years;
      pts = pts.filter((p) => p.x >= cut);
    }
    const width = Math.max(280, fig.clientWidth || 360);
    const height = width < 480 ? 210 : 240;
    const m = { l: 32, r: 10, t: 14, b: 24 };
    const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
    const yMin = Math.min(-2.5, ...pts.map((p) => p.v)), yMax = Math.max(2.8, ...pts.map((p) => p.v));
    const sx = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (width - m.l - m.r);
    const sy = (v) => m.t + ((yMax - v) / (yMax - yMin)) * (height - m.t - m.b);
    const area = (fn) => `M${sx(pts[0].x)},${sy(0)} ${pts.map((p) => `L${sx(p.x).toFixed(1)},${sy(fn(p.v)).toFixed(1)}`).join(" ")} L${sx(x1)},${sy(0)} Z`;
    const span = x1 - x0;
    const step = span > 40 ? 10 : span > 15 ? 5 : 2;
    const xTicks = [];
    for (let y = Math.ceil(x0 / step) * step; y <= x1; y += step) xTicks.push(y);
    const yTicks = [-2, -1, 0, 1, 2].filter((v) => v >= yMin && v <= yMax);

    fig.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
        aria-label="Oceanic Niño Index from ${escapeHtml(pts[0].label)} to ${escapeHtml(pts[pts.length - 1].label)}">
      <g class="grid">${yTicks.filter((v) => v !== 0).map((v) => `<line x1="${m.l}" x2="${width - m.r}" y1="${sy(v)}" y2="${sy(v)}"/>`).join("")}</g>
      <path d="${area((v) => Math.max(v, 0))}" fill="var(--warm-mark)"/>
      <path d="${area((v) => Math.min(v, 0))}" fill="var(--cool-mark)"/>
      <line class="zero" x1="${m.l}" x2="${width - m.r}" y1="${sy(0)}" y2="${sy(0)}"/>
      <line class="threshold" x1="${m.l}" x2="${width - m.r}" y1="${sy(0.5)}" y2="${sy(0.5)}"/>
      <line class="threshold" x1="${m.l}" x2="${width - m.r}" y1="${sy(-0.5)}" y2="${sy(-0.5)}"/>
      <text class="threshold-label" x="${m.l + 4}" y="${sy(yMax) + 10}">El Niño ≥ +0.5</text>
      <text class="threshold-label" x="${m.l + 4}" y="${sy(yMin) - 4}">La Niña ≤ −0.5</text>
      <g class="axis">
        ${yTicks.map((v) => `<text x="${m.l - 6}" y="${sy(v) + 4}" text-anchor="end">${v > 0 ? "+" : ""}${v}</text>`).join("")}
        ${xTicks.map((y) => `<text x="${sx(y)}" y="${height - 6}" text-anchor="middle">${y}</text>`).join("")}
      </g>
      <line class="crosshair" id="oni-cross" y1="${m.t}" y2="${height - m.b}" visibility="hidden"/>
      <circle id="oni-dot" r="4" fill="var(--text)" stroke="var(--bg-solid)" stroke-width="2" visibility="hidden"/>
      <rect id="oni-hit" x="${m.l}" y="0" width="${width - m.l - m.r}" height="${height}" fill="transparent"/>
    </svg><div class="chart-tip" id="oni-tip" hidden></div>`;

    const hit = $("oni-hit"), cross = $("oni-cross"), dot = $("oni-dot"), tip = $("oni-tip");
    const show = (e) => {
      const rect = fig.querySelector("svg").getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * width;
      const xv = x0 + ((px - m.l) / (width - m.l - m.r)) * (x1 - x0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.x - xv) < Math.abs(best.x - xv)) best = p;
      const cx = sx(best.x), cy = sy(best.v);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible");
      const v1 = Math.round(best.v * 10) / 10; // NOAA publishes the ONI to one decimal
      const phase = v1 >= 0.5 ? "El Niño range" : v1 <= -0.5 ? "La Niña range" : "Neutral";
      tip.innerHTML = `<b>${escapeHtml(best.label)}</b> · ${signed(best.v)} °C · ${phase}`;
      tip.hidden = false;
      tip.style.left = `${clamp((cx / width) * rect.width, 70, rect.width - 70)}px`;
      tip.style.top = `${(cy / height) * rect.height}px`;
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", hide);
  }

  document.querySelectorAll("#history-range .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      historyState.years = Number(chip.dataset.years);
      document.querySelectorAll("#history-range .chip").forEach((c) => c.classList.toggle("active", c === chip));
      renderHistory();
    });
  });
  $("show-la-nina").addEventListener("change", renderEpisodes);
  window.addEventListener("resize", () => { if (ui.tab === "history") renderHistory(); });

  // ------------------------------------------------------------------
  // El Niño news and videos
  // ------------------------------------------------------------------
  const PAGE_SIZE = 40;
  const newsState = {
    data: null, loadedAt: 0, tab: "articles", shown: PAGE_SIZE,
    filters: { theme: "", country: "", language: "", q: "" },
  };
  const THEME_BY_ID = Object.fromEntries(IMPACTS.themes.map((t) => [t.id, t]));
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

  function timeAgo(iso) {
    if (!iso) return "";
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 60) return `${Math.max(mins, 1)} min ago`;
    if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
    return `${Math.round(mins / 1440)} days ago`;
  }

  function newsItemHtml(a) {
    const url = safeUrl(a.url);
    if (!url) return "";
    const img = safeUrl(a.image);
    const tags = [
      ...(a.themes || []).filter((t) => THEME_BY_ID[t]).map((t) => `<span class="tag">${THEME_BY_ID[t].icon} ${escapeHtml(THEME_BY_ID[t].title)}</span>`),
      ...(a.countries || []).filter((c) => IMPACT_BY_SLUG[c]).slice(0, 3).map((c) => `<span class="tag">📍 ${escapeHtml(IMPACT_BY_SLUG[c].name)}</span>`),
    ].join("");
    return `<a class="news-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
      ${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
      <div><div class="news-title">${escapeHtml(a.title)}</div>
        <div class="news-meta">${a.country ? `<span class="flag">${escapeHtml(a.country)}</span>` : ""}${escapeHtml(a.source)}${a.language ? ` · ${escapeHtml(a.language)}` : ""}${a.published ? ` · ${escapeHtml(timeAgo(a.published))}` : ""}</div>
        ${tags ? `<div class="news-tags">${tags}</div>` : ""}</div>
    </a>`;
  }

  function fillNewsSelects() {
    const d = newsState.data;
    const slugCounts = {}, editionCounts = {}, langCounts = {};
    d.articles.forEach((a) => {
      (a.countries || []).forEach((c) => { if (IMPACT_BY_SLUG[c]) slugCounts[c] = (slugCounts[c] || 0) + 1; });
      if (a.country) editionCounts[a.country] = (editionCounts[a.country] || 0) + 1;
      if (a.language) langCounts[a.language] = (langCounts[a.language] || 0) + 1;
    });
    const covered = new Set(Object.keys(slugCounts).map((s) => IMPACT_BY_SLUG[s].name));
    const options = [
      ...Object.entries(slugCounts).map(([s, n]) => [`slug:${s}`, IMPACT_BY_SLUG[s].name, n]),
      ...Object.entries(editionCounts).filter(([name]) => !covered.has(name)).map(([name, n]) => [`ed:${name}`, name, n]),
    ].sort((a, b) => a[1].localeCompare(b[1]));
    $("news-country").innerHTML = `<option value="">All countries</option>${options.map(([v, label, n]) =>
      `<option value="${escapeHtml(v)}">${escapeHtml(label)} (${n})</option>`).join("")}`;
    $("news-language").innerHTML = `<option value="">All languages</option>${Object.entries(langCounts)
      .sort((a, b) => b[1] - a[1]).map(([l, n]) => `<option value="${escapeHtml(l)}">${escapeHtml(l)} (${n})</option>`).join("")}`;
  }

  function filteredArticles() {
    const { theme, country, language, q } = newsState.filters;
    const query = q.trim().toLowerCase();
    return newsState.data.articles.filter((a) =>
      (!theme || (a.themes || []).includes(theme))
      && (!country || (country.startsWith("slug:") ? (a.countries || []).includes(country.slice(5)) : a.country === country.slice(3)))
      && (!language || a.language === language)
      && (!query || a.title.toLowerCase().includes(query) || (a.source || "").toLowerCase().includes(query)));
  }

  function renderArticles() {
    const items = filteredArticles();
    if (!items.length) {
      $("news-body").innerHTML = '<p class="muted">No El Niño news matches these filters right now. Try "All".</p>';
      return;
    }
    const shown = items.slice(0, newsState.shown);
    $("news-body").innerHTML = shown.map(newsItemHtml).join("")
      + (items.length > shown.length ? `<button class="more-btn" id="news-more">Show more (${items.length - shown.length} more)</button>` : "");
    if ($("news-more")) $("news-more").addEventListener("click", () => { newsState.shown += PAGE_SIZE; renderArticles(); });
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
      <h3 class="section-title">Latest from weather &amp; climate agencies</h3>
      ${latest.length ? `<div class="video-grid">${latest.map(card).join("")}</div>`
        : '<p class="muted">No new El Niño videos from NOAA, NASA, WMO, the Met Office or the Bureau of Meteorology in their latest uploads.</p>'}
      <h3 class="section-title">Explainers</h3>
      <div class="video-grid">${videos.filter((v) => v.explainer).map(card).join("")}</div>`;
    $("news-body").querySelectorAll(".video-card").forEach((btn) => {
      btn.addEventListener("click", () => playVideo(btn.dataset.id, btn.dataset.title));
    });
  }

  function renderNews() {
    const d = newsState.data;
    document.querySelectorAll("[data-news-tab]").forEach((b) => b.classList.toggle("active", b.dataset.newsTab === newsState.tab));
    $("news-filters").hidden = newsState.tab !== "articles";
    if (!d) return;
    const f = newsState.filters;
    document.querySelectorAll("#news-themes .chip").forEach((c) => c.classList.toggle("active", c.dataset.theme === f.theme));
    if ([...$("news-country").options].some((o) => o.value === f.country)) $("news-country").value = f.country;
    else f.country = $("news-country").value = "";
    $("news-language").value = f.language;
    if (newsState.tab === "articles") renderArticles(); else renderVideos();
    const ok = d.sources.filter((src) => src.ok).length;
    $("news-foot").innerHTML = `${d.articles.length} articles · ${d.videos.length} videos from ${ok} free sources
      · updated ${escapeHtml(timeAgo(d.updated))} · <button class="link-btn" id="news-sources">Sources</button>`;
    $("news-sources").addEventListener("click", () => $("sources-btn").click());
  }

  async function loadNews() {
    try {
      const d = await api("/api/news");
      // The map app shows headlines; papers, podcasts and discussions live on the News page.
      d.articles = (d.articles || []).filter((x) => ["news", "official", "report", "science"].includes(x.kind || "news") && x.elnino !== false);
      newsState.data = d;
      newsState.loadedAt = Date.now();
      fillNewsSelects();
      renderNews();
      if (impactsState.selected) renderImpactDetail();
      if (!$("sources-panel").hidden) renderSources();
    } catch (err) {
      $("news-body").innerHTML = `<p class="muted">News is unavailable right now: ${escapeHtml(err.message)}</p>`;
    }
  }

  const resetPaging = () => { newsState.shown = PAGE_SIZE; };
  document.querySelectorAll("[data-news-tab]").forEach((b) => b.addEventListener("click", () => { newsState.tab = b.dataset.newsTab; renderNews(); }));
  document.querySelectorAll("#news-themes .chip").forEach((chip) => chip.addEventListener("click", () => {
    newsState.filters.theme = chip.dataset.theme; resetPaging(); renderNews();
  }));
  $("news-country").addEventListener("change", (e) => { newsState.filters.country = e.target.value; resetPaging(); renderNews(); });
  $("news-language").addEventListener("change", (e) => { newsState.filters.language = e.target.value; resetPaging(); renderNews(); });
  let searchTimer;
  $("news-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { newsState.filters.q = e.target.value; resetPaging(); if (newsState.data) renderArticles(); }, 200);
  });

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

  $("video-close").addEventListener("click", closeVideo);
  $("video-modal").addEventListener("click", (e) => { if (e.target === $("video-modal")) closeVideo(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("video-modal").hidden) closeVideo();
    else if (!$("sources-panel").hidden) $("sources-panel").hidden = true;
    else setLayersOpen(false);
  });

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
        }, "anchor-impacts");
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

  function updateGlobeImpacts() {
    const gm = globe.map;
    if (!gm || !globe.ready) return;
    ["impacts-fill", "impacts-line", "impacts-points"].forEach((id) => { if (gm.getLayer(id)) gm.removeLayer(id); });
    ["impacts", "impact-points"].forEach((id) => { if (gm.getSource(id)) gm.removeSource(id); });
    if (!impactsState.on || !impactsState.geo) return;
    const selected = impactsState.selected || "";
    gm.addSource("impacts", { type: "geojson", data: impactsState.geo });
    gm.addSource("impact-points", {
      type: "geojson",
      data: { type: "FeatureCollection", features: POINT_COUNTRIES.map((c) => ({
        type: "Feature", properties: { slug: c.slug, color: effectColor(c.effect) },
        geometry: { type: "Point", coordinates: [c.lon, c.lat] } })) },
    });
    gm.addLayer({ id: "impacts-fill", type: "fill", source: "impacts",
      paint: { "fill-color": ["get", "color"], "fill-opacity": ["case", ["==", ["get", "slug"], selected], 0.7, 0.45] } }, "anchor-sst");
    gm.addLayer({ id: "impacts-line", type: "line", source: "impacts",
      paint: { "line-color": ["get", "color"], "line-width": ["case", ["==", ["get", "slug"], selected], 3, 1] } }, "anchor-sst");
    gm.addLayer({ id: "impacts-points", type: "circle", source: "impact-points",
      paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }, "anchor-sst");
  }

  function updateGlobePadding() {
    if (globe.map && globe.active) globe.map.easeTo({ padding: viewPadding(), duration: 280 });
  }

  async function createGlobe() {
    await loadMapLibre();
    const gm = new maplibregl.Map({
      container: "globe",
      center: [-140, 0], // the equatorial Pacific
      zoom: isSheetMode() ? 1.3 : 1.9,
      maxZoom: 12,
      attributionControl: false,
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
        // Hidden "anchor" layers keep the stacking order stable as layers come and go:
        // imagery < satellites < impacts < sea temperature < night < labels < Niño boxes.
        layers: [
          { id: "space", type: "background", paint: { "background-color": "#a9c4e6" } },
          { id: "imagery", type: "raster", source: "imagery" },
          { id: "anchor-impacts", type: "background", layout: { visibility: "none" } },
          { id: "anchor-sst", type: "background", layout: { visibility: "none" } },
          { id: "night", type: "fill", source: "night", paint: { "fill-color": "#000814", "fill-opacity": 0.4 } },
          { id: "labels", type: "raster", source: "labels" },
        ],
      },
    });
    gm.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    gm.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    gm.on("load", () => {
      globe.ready = true;
      // Start with the credits folded into the (i) button.
      const attrib = gm.getContainer().querySelector(".maplibregl-ctrl-attrib");
      if (attrib) attrib.classList.remove("maplibregl-compact-show");
      gm.setPadding(viewPadding());
      updateGlobeSatellites();
      updateGlobeNight();
      updateGlobeEnso();
      updateGlobeImpacts();
    });
    const pick = (e) => { const f = e.features && e.features[0]; if (f) selectCountry(f.properties.slug, { fly: false }); };
    gm.on("click", "impacts-fill", pick);
    gm.on("click", "impacts-points", pick);
    ["impacts-fill", "impacts-points"].forEach((id) => {
      gm.on("mouseenter", id, () => { gm.getCanvas().style.cursor = "pointer"; });
      gm.on("mouseleave", id, () => { gm.getCanvas().style.cursor = ""; });
    });
    globe.map = gm;
  }

  function setViewButtons() {
    $("globe-toggle").setAttribute("aria-pressed", String(globe.active));
    $("map-toggle").setAttribute("aria-pressed", String(!globe.active));
  }

  async function showGlobe() {
    globe.active = true;
    document.body.classList.add("globe-mode");
    $("globe").hidden = false;
    setViewButtons();
    try {
      if (!globe.map) await createGlobe();
      else {
        const c = map.getCenter();
        globe.map.resize();
        globe.map.jumpTo({ center: [((c.lng + 540) % 360) - 180, clamp(c.lat, -60, 60)], padding: viewPadding() });
        updateGlobeSatellites();
        updateGlobeNight();
        updateGlobeImpacts();
      }
    } catch (err) {
      toast(err.message);
      hideGlobe();
    }
  }

  function hideGlobe() {
    globe.active = false;
    document.body.classList.remove("globe-mode");
    $("globe").hidden = true;
    setViewButtons();
    map.invalidateSize();
  }

  $("globe-toggle").addEventListener("click", showGlobe);
  $("map-toggle").addEventListener("click", hideGlobe);


  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  setSheetState(isSheetMode() ? "half" : "half");
  updateLegend();
  loadClouds();
  updateNight();
  loadEnso();
  showGlobe();
  routeFromHash();
  // Fetch the news shortly after the first paint so headlines are ready.
  setTimeout(() => { if (!newsState.data) loadNews(); }, 1500);
})();
