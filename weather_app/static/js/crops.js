/* Crops page: El Niño effects on crops by country, growing-region rainfall,
   world prices with El Niño periods shaded, and crop news. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
  const signed = (v, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const SEASONS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"];
  const fmtMonth = (ym) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

  const INFO = JSON.parse($("crops-info").textContent);
  const COUNTRIES = JSON.parse($("countries-info").textContent);
  const STATIC_SITE = Boolean(window.APP_CONFIG && window.APP_CONFIG.static);
  const state = { country: "", crop: "", q: "", data: { prices: {}, rain: {}, fx: null }, cur: "", lastCountry: "", news: null, enso: null, priceYears: 0, newsShown: 30 };

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 4000);
  }

  // Static site: pre-built files next to the page. Server: the JSON API.
  async function getJson(staticName, apiPath) {
    const url = STATIC_SITE
      ? new URL(`../data/${staticName}?v=${Math.floor(Date.now() / 300e3)}`, window.location.href)
      : new URL(apiPath, window.location.origin);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Data not available (${res.status})`);
    return res.json();
  }

  async function rainFor(region) {
    if (state.data.rain[region.id]) return state.data.rain[region.id];
    if (STATIC_SITE) return null;
    const r = await getJson("", `/api/crops/rain?region=${encodeURIComponent(region.id)}`);
    state.data.rain[region.id] = r;
    return r;
  }

  // ------------------------------------------------------------------
  // Charts (SVG). Colours validated on the dark surface; text uses ink tokens.
  // ------------------------------------------------------------------
  function attachTooltip(fig, width, height, points, describe) {
    const svg = fig.querySelector("svg");
    const tip = fig.querySelector(".chart-tip");
    const cross = fig.querySelector(".crosshair");
    const hit = fig.querySelector(".hit");
    const show = (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * width;
      let best = points[0];
      for (const p of points) if (Math.abs(p.cx - px) < Math.abs(best.cx - px)) best = p;
      if (cross) { cross.setAttribute("x1", best.cx); cross.setAttribute("x2", best.cx); cross.setAttribute("visibility", "visible"); }
      tip.innerHTML = describe(best);
      tip.hidden = false;
      tip.style.left = `${clamp((best.cx / width) * rect.width, 80, rect.width - 80)}px`;
      tip.style.top = `${(best.cy / height) * rect.height}px`;
    };
    const hide = () => { tip.hidden = true; if (cross) cross.setAttribute("visibility", "hidden"); };
    hit.addEventListener("pointermove", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", hide);
  }

  function rainChart(fig, rain) {
    const months = rain.months;
    const width = Math.max(280, fig.clientWidth || 340);
    const height = 200;
    const m = { l: 36, r: 8, t: 12, b: 26 };
    const max = Math.max(10, ...months.map((x) => Math.max(x.rain, x.normal || 0))) * 1.1;
    const slot = (width - m.l - m.r) / months.length;
    const bw = Math.max(6, slot - 6);
    const sy = (v) => m.t + (1 - v / max) * (height - m.t - m.b);
    const ticks = [0, max / 2, max].map((v) => Math.round(v / 10) * 10);
    const points = months.map((x, i) => ({ ...x, cx: m.l + slot * i + slot / 2, cy: sy(Math.max(x.rain, x.normal || 0)) }));
    fig.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
        aria-label="Monthly rainfall for the last ${months.length} months against the long-term average">
      <g class="grid">${ticks.slice(1).map((v) => `<line x1="${m.l}" x2="${width - m.r}" y1="${sy(v)}" y2="${sy(v)}"/>`).join("")}</g>
      ${points.map((p) => `<rect x="${(p.cx - bw / 2).toFixed(1)}" y="${sy(p.rain).toFixed(1)}" width="${bw.toFixed(1)}"
          height="${Math.max(0, sy(0) - sy(p.rain)).toFixed(1)}" rx="3" fill="var(--rain-mark)"/>`).join("")}
      ${points.filter((p) => p.normal != null).map((p) => `<line class="normal-tick" x1="${(p.cx - bw / 2 - 2).toFixed(1)}" x2="${(p.cx + bw / 2 + 2).toFixed(1)}"
          y1="${sy(p.normal).toFixed(1)}" y2="${sy(p.normal).toFixed(1)}"/>`).join("")}
      <line class="zero" x1="${m.l}" x2="${width - m.r}" y1="${sy(0)}" y2="${sy(0)}"/>
      <g class="axis">
        ${ticks.map((v) => `<text x="${m.l - 6}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`).join("")}
        ${points.map((p, i) => (i % 2 === 0 || slot > 34) ? `<text x="${p.cx}" y="${height - 8}" text-anchor="middle">${MONTH_NAMES[Number(p.month.slice(5)) - 1]}</text>` : "").join("")}
      </g>
      <rect class="hit" x="${m.l}" y="0" width="${width - m.l - m.r}" height="${height}" fill="transparent"/>
    </svg><div class="chart-tip" hidden></div>`;
    attachTooltip(fig, width, height, points, (p) =>
      `<b>${fmtMonth(p.month)}</b> · ${Math.round(p.rain)} mm${p.normal != null ? ` · normal ${Math.round(p.normal)} mm (${p.pct}%)` : ""}`);
  }

  function elNinoPeriods() {
    const eps = (state.enso && state.enso.episodes) || [];
    const toX = (label) => {
      const [season, year] = label.split(" ");
      return Number(year) + (SEASONS.indexOf(season) + 0.5) / 12;
    };
    return eps.filter((e) => e.phase === "el_nino" && e.confirmed !== false).map((e) => ({ x0: toX(e.start), x1: toX(e.end), e }));
  }

  function priceChart(fig, price) {
    const view = priceView(price);
    let series = price.series.map(([ym, v]) => ({ ym, v: view.conv(v), x: Number(ym.slice(0, 4)) + (Number(ym.slice(5, 7)) - 0.5) / 12 }));
    if (state.priceYears) {
      const cut = series[series.length - 1].x - state.priceYears;
      series = series.filter((p) => p.x >= cut);
    }
    const width = Math.max(280, fig.clientWidth || 340);
    const height = 220;
    const m = { l: 44, r: 10, t: 12, b: 26 };
    const x0 = series[0].x, x1 = series[series.length - 1].x;
    const vmax = Math.max(...series.map((p) => p.v)) * 1.08;
    const sx = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (width - m.l - m.r);
    const sy = (v) => m.t + (1 - v / vmax) * (height - m.t - m.b);
    const periods = elNinoPeriods().filter((p) => p.x1 >= x0 && p.x0 <= x1);
    const span = x1 - x0;
    const step = span > 25 ? 5 : span > 12 ? 2 : 1;
    const xTicks = [];
    for (let y = Math.ceil(x0 / step) * step; y <= x1; y += step) xTicks.push(y);
    const yTicks = [0, vmax / 3, (2 * vmax) / 3].map((v) => Number(v.toPrecision(2)));
    const tickText = (v) => (v >= 1e6 ? `${+(v / 1e6).toPrecision(3)}M` : v >= 1e4 ? `${+(v / 1e3).toPrecision(3)}k` : `${v}`);
    const inPeriod = (x) => periods.find((p) => x >= p.x0 && x <= p.x1);
    const points = series.map((p) => ({ ...p, cx: sx(p.x), cy: sy(p.v) }));
    const path = points.map((p, i) => `${i ? "L" : "M"}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(" ");
    fig.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
        aria-label="${escapeHtml(price.label)} world price in ${escapeHtml(view.unit)} with El Niño periods shaded">
      ${periods.map((p) => `<rect x="${sx(Math.max(p.x0, x0)).toFixed(1)}" y="${m.t}" width="${Math.max(1, sx(Math.min(p.x1, x1)) - sx(Math.max(p.x0, x0))).toFixed(1)}"
          height="${height - m.t - m.b}" class="nino-band"/>`).join("")}
      <g class="grid">${yTicks.slice(1).map((v) => `<line x1="${m.l}" x2="${width - m.r}" y1="${sy(v)}" y2="${sy(v)}"/>`).join("")}</g>
      <path d="${path}" fill="none" stroke="var(--price-mark)" stroke-width="2" stroke-linejoin="round"/>
      <line class="zero" x1="${m.l}" x2="${width - m.r}" y1="${sy(0)}" y2="${sy(0)}"/>
      <g class="axis">
        ${yTicks.map((v) => `<text x="${m.l - 6}" y="${sy(v) + 4}" text-anchor="end">${tickText(v)}</text>`).join("")}
        ${xTicks.map((y) => `<text x="${sx(y)}" y="${height - 8}" text-anchor="middle">${y}</text>`).join("")}
      </g>
      <line class="crosshair" y1="${m.t}" y2="${height - m.b}" visibility="hidden"/>
      <rect class="hit" x="${m.l}" y="0" width="${width - m.l - m.r}" height="${height}" fill="transparent"/>
    </svg><div class="chart-tip" hidden></div>`;
    attachTooltip(fig, width, height, points, (p) => {
      const period = inPeriod(p.x);
      return `<b>${fmtMonth(p.ym)}</b> · ${escapeHtml(view.fmt(p.v))} ${escapeHtml(view.local ? "per kg" : view.unit)}`
        + (period ? ` · El Niño (${period.e.strength})` : "");
    });
  }

  // ------------------------------------------------------------------
  // Detail views
  // ------------------------------------------------------------------
  const outlookBadge = (o) => `<span class="outlook" style="--o:${INFO.outlooks[o].color}">${INFO.outlooks[o].icon} ${INFO.outlooks[o].label}</span>`;
  const pctText = (pct) => (pct == null ? "no data" : `${pct}% of normal`);
  const pctClass = (pct) => (pct == null ? "" : pct < 80 ? "dry" : pct > 120 ? "wet" : "near");

  // ------------------------------------------------------------------
  // Currency: world prices are in US$; show them in the chosen country's money
  // ------------------------------------------------------------------
  const rateOf = (cur) => (cur === "USD" ? 1 : state.data.fx && state.data.fx.rates[cur]);
  function currency(auto = false) {
    const wanted = (!auto && state.cur) || INFO.currencies[state.country || state.lastCountry] || "USD";
    return rateOf(wanted) ? wanted : "USD";
  }
  function money(v, cur, digits) {
    const maximumFractionDigits = digits ?? (v < 10 ? 2 : v < 1000 ? 1 : 0);
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 0, maximumFractionDigits }).format(v);
    } catch (e) {
      return `${cur} ${v.toLocaleString(undefined, { maximumFractionDigits })}`;
    }
  }
  function curSymbol(cur) {
    const parts = new Intl.NumberFormat(undefined, { style: "currency", currency: cur, currencyDisplay: "narrowSymbol" }).formatToParts(0);
    return (parts.find((p) => p.type === "currency") || {}).value || cur;
  }
  function curName(cur) {
    try { return new Intl.DisplayNames(undefined, { type: "currency" }).of(cur); } catch (e) { return cur; }
  }
  // How to show one crop's price: the world unit in US$, or local money per kg.
  function priceView(price) {
    const cur = currency();
    if (cur === "USD" || !price.usd_per_kg) {
      return { local: false, cur: "USD", unit: price.unit, conv: (v) => v, fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }) };
    }
    const k = price.usd_per_kg * rateOf(cur);
    return { local: true, cur, unit: `${curSymbol(cur)} per kg`, conv: (v) => v * k, fmt: (v) => money(v, cur) };
  }
  function fxNote(view) {
    if (!view.local) return "";
    const fx = state.data.fx;
    const day = fx.date ? new Date(fx.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "today";
    return `<p class="muted fx-note">Converted from the world price in US$ at today's rate: 1 US$ = ${money(rateOf(view.cur), view.cur, 2)}
      (${escapeHtml(curName(view.cur))}, ${escapeHtml(day)}, <a href="${escapeHtml(fx.source_url)}" target="_blank" rel="noopener">Rates by Exchange Rate API</a>).
      Earlier months use today's rate too, so the chart shows the world price trend, not past local prices.
      Local market prices also include transport, taxes and margins.</p>`;
  }

  function priceBlock(cropId) {
    const price = state.data.prices[cropId];
    const crop = INFO.crops[cropId];
    if (!price) return `<p class="muted">The world ${escapeHtml(crop.name.toLowerCase())} price is not available right now.</p>`;
    const chg = price.change_12m_pct;
    const view = priceView(price);
    const usd = `${price.latest.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${escapeHtml(price.unit)}`;
    return `<div class="stat-row">
        <div class="stat"><span class="stat-value">${escapeHtml(view.fmt(view.conv(price.latest)))}</span>
          <span class="stat-label">${escapeHtml(view.unit)} · ${fmtMonth(price.latest_month)}</span></div>
        ${view.local ? `<div class="stat"><span class="stat-value">${escapeHtml(money(view.conv(price.latest) * 1000, view.cur, 0))}</span>
          <span class="stat-label">per tonne</span></div>` : ""}
        ${chg != null ? `<div class="stat"><span class="stat-value">${chg >= 0 ? "▲" : "▼"} ${Math.abs(chg)}%</span>
          <span class="stat-label">world price vs a year earlier</span></div>` : ""}
      </div>
      ${view.local ? `<p class="muted">World price: ${usd}.</p>` : ""}
      <div class="chips" id="price-range" role="group" aria-label="Time range">
        ${[[0, "Since 1990"], [20, "20 years"], [10, "10 years"]].map(([y, l]) =>
          `<button class="chip ${state.priceYears === y ? "active" : ""}" data-years="${y}">${l}</button>`).join("")}
      </div>
      <figure class="crop-chart" id="price-chart"></figure>
      <p class="chart-legend"><span><i class="lg-line"></i>${escapeHtml(price.label)}</span><span><i class="lg-band"></i>El Niño period (NOAA ONI)</span></p>
      <p class="muted">Source: IMF Primary Commodity Prices via <a href="${escapeHtml(price.source_url)}" target="_blank" rel="noopener">FRED</a>.
        Prices also move with demand, policy, currencies and energy costs, not only weather.</p>
      ${fxNote(view)}`;
  }

  function drawPrice(cropId) {
    const price = state.data.prices[cropId];
    if (!price || !$("price-chart")) return;
    priceChart($("price-chart"), price);
    document.querySelectorAll("#price-range .chip").forEach((chip) => chip.addEventListener("click", () => {
      state.priceYears = Number(chip.dataset.years);
      document.querySelectorAll("#price-range .chip").forEach((c) => c.classList.toggle("active", c === chip));
      priceChart($("price-chart"), price);
    }));
  }

  async function renderRegion(region) {
    const crop = INFO.crops[region.crop];
    const country = COUNTRIES[region.country];
    $("crop-detail").innerHTML = `<article class="card crop-card">
      <h2>${crop.icon} ${escapeHtml(crop.name)} in ${escapeHtml(country.name)}</h2>
      <p>${outlookBadge(region.outlook)} <span class="muted">${escapeHtml(region.region)} · ${escapeHtml(region.season)}</span></p>
      <p>${escapeHtml(region.note)}</p>
      <h3 class="section-title">Rain in ${escapeHtml(region.region)}</h3>
      <div id="rain-block"><p class="muted">Loading rainfall…</p></div>
      <h3 class="section-title">World ${escapeHtml(crop.name.toLowerCase())} price</h3>
      ${priceBlock(region.crop)}
      <p><a href="../impacts/${encodeURIComponent(region.country)}/">El Niño impact on ${escapeHtml(country.name)} →</a></p>
    </article>`;
    drawPrice(region.crop);
    try {
      const rain = await rainFor(region);
      if (!rain || !rain.months || !rain.months.length) throw new Error("no data");
      $("rain-block").innerHTML = `<div class="stat-row">
          <div class="stat ${pctClass(rain.last3_pct)}"><span class="stat-value">${rain.last3_pct ?? "–"}%</span>
            <span class="stat-label">of normal rain, last 3 months</span></div></div>
        <figure class="crop-chart" id="rain-chart"></figure>
        <p class="chart-legend"><span><i class="lg-bar"></i>Monthly rain (mm)</span><span><i class="lg-tick"></i>Long-term average</span></p>
        <p class="muted">Rainfall at ${region.lat.toFixed(1)}°, ${region.lon.toFixed(1)}° from NASA POWER (satellite and model data).</p>`;
      rainChart($("rain-chart"), rain);
    } catch (e) {
      $("rain-block").innerHTML = '<p class="muted">Rainfall for this region is not available right now.</p>';
    }
  }

  function renderCountry(slug) {
    const regions = INFO.regions.filter((r) => r.country === slug);
    const country = COUNTRIES[slug];
    $("crop-detail").innerHTML = `<article class="card crop-card">
      <h2>El Niño and crops in ${escapeHtml(country.name)}</h2>
      <p class="muted">${escapeHtml(country.summary)}</p>
      <div class="crop-mini-grid">${regions.map((r) => {
        const rain = state.data.rain[r.id];
        return `<button class="crop-mini" data-region="${r.id}">
          <b>${INFO.crops[r.crop].icon} ${escapeHtml(INFO.crops[r.crop].name)}</b>
          ${outlookBadge(r.outlook)}
          <small class="${pctClass(rain && rain.last3_pct)}">Rain: ${rain ? pctText(rain.last3_pct) : "tap for details"}</small>
        </button>`;
      }).join("")}</div>
      <p><a href="../impacts/${encodeURIComponent(slug)}/">El Niño impact on ${escapeHtml(country.name)} →</a></p>
    </article>`;
    $("crop-detail").querySelectorAll(".crop-mini").forEach((b) => b.addEventListener("click", () => {
      const r = INFO.regions.find((x) => x.id === b.dataset.region);
      select(r.country, r.crop);
    }));
  }

  function renderCrop(cropId) {
    const crop = INFO.crops[cropId];
    const regions = INFO.regions.filter((r) => r.crop === cropId);
    $("crop-detail").innerHTML = `<article class="card crop-card">
      <h2>${crop.icon} El Niño and ${escapeHtml(crop.name.toLowerCase())}</h2>
      <p class="muted">Where El Niño usually matters for ${escapeHtml(crop.name.toLowerCase())}:
        ${regions.map((r) => `<button class="link-btn inline" data-region="${r.id}">${escapeHtml(COUNTRIES[r.country].name)}</button>`).join(", ") || "no main regions listed"}.</p>
      ${priceBlock(cropId)}
    </article>`;
    drawPrice(cropId);
    $("crop-detail").querySelectorAll("[data-region]").forEach((b) => b.addEventListener("click", () => {
      const r = INFO.regions.find((x) => x.id === b.dataset.region);
      select(r.country, r.crop);
    }));
  }

  function renderDetail() {
    const { country, crop } = state;
    const region = INFO.regions.find((r) => r.country === country && r.crop === crop);
    if (region) renderRegion(region);
    else if (country && crop) {
      renderCountry(country);
      $("crop-detail").querySelector(".crop-card").insertAdjacentHTML("afterbegin",
        `<p class="note">${escapeHtml(INFO.crops[crop].name)} is not one of the main El Niño-sensitive crops listed for ${escapeHtml(COUNTRIES[country].name)}.</p>`);
    } else if (country) renderCountry(country);
    else if (crop) renderCrop(crop);
    else $("crop-detail").innerHTML = "";
  }

  // ------------------------------------------------------------------
  // Table, price cards and news
  // ------------------------------------------------------------------
  function filterTable() {
    const q = state.q.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll("#crop-table tbody tr").forEach((tr) => {
      const match = (!state.country || tr.dataset.country === state.country)
        && (!state.crop || tr.dataset.crop === state.crop)
        && (!q || tr.textContent.toLowerCase().includes(q));
      tr.hidden = !match;
      tr.classList.toggle("selected", tr.dataset.country === state.country && tr.dataset.crop === state.crop);
      if (match) shown += 1;
    });
    return shown;
  }

  function fillRainCells() {
    document.querySelectorAll(".rain-cell").forEach((td) => {
      const rain = state.data.rain[td.dataset.region];
      if (!rain) return;
      td.innerHTML = `<span class="${pctClass(rain.last3_pct)}">${pctText(rain.last3_pct)}</span>`;
    });
  }

  function renderPriceCards() {
    document.querySelectorAll(".price-card").forEach((card) => {
      const price = state.data.prices[card.dataset.crop];
      const v = card.querySelector(".pc-value");
      card.classList.toggle("active", card.dataset.crop === state.crop);
      if (!price) { v.textContent = "Not available"; return; }
      const chg = price.change_12m_pct;
      const view = priceView(price);
      v.classList.remove("muted");
      v.innerHTML = `<b>${escapeHtml(view.fmt(view.conv(price.latest)))}</b> <small>${escapeHtml(view.unit)}</small>
        ${chg != null ? `<small>${chg >= 0 ? "▲" : "▼"} ${Math.abs(chg)}% in a year</small>` : ""}`;
    });
  }

  function newsItem(a) {
    const url = safeUrl(a.url);
    if (!url) return "";
    const crops = (a.crops || []).filter((c) => INFO.crops[c]).map((c) => `<span class="tag">${INFO.crops[c].icon} ${escapeHtml(INFO.crops[c].name)}</span>`);
    const places = (a.countries || []).filter((c) => COUNTRIES[c]).slice(0, 3).map((c) => `<span class="tag">📍 ${escapeHtml(COUNTRIES[c].name)}</span>`);
    return `<a class="news-item" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><div>
      <div class="news-title">${escapeHtml(a.title)}</div>
      <div class="news-meta">${a.country ? `<span class="flag">${escapeHtml(a.country)}</span>` : ""}${escapeHtml(a.source)}${a.language ? ` · ${escapeHtml(a.language)}` : ""}${a.published ? ` · ${escapeHtml(a.published.slice(0, 10))}` : ""}</div>
      ${crops.length || places.length ? `<div class="news-tags">${[...crops, ...places].join("")}</div>` : ""}</div></a>`;
  }

  function renderNews() {
    if (!state.news) return;
    const q = state.q.trim().toLowerCase();
    const items = state.news.articles.filter((a) => (a.crops || []).length || (a.themes || []).includes("food"))
      .filter((a) => (!state.crop || (a.crops || []).includes(state.crop))
        && (!state.country || (a.countries || []).includes(state.country))
        && (!q || a.title.toLowerCase().includes(q)));
    const what = [state.crop && INFO.crops[state.crop].name, state.country && COUNTRIES[state.country].name].filter(Boolean).join(" · ");
    $("crop-news-title").textContent = what ? `Crop news: ${what}` : "Latest crop news";
    if (!items.length) {
      $("crop-news").innerHTML = `<p class="muted">No recent El Niño crop news for this selection. Try "All crops" or another country.</p>`;
      return;
    }
    const shown = items.slice(0, state.newsShown);
    $("crop-news").innerHTML = shown.map(newsItem).join("")
      + (items.length > shown.length ? `<button class="more-btn" id="crop-news-more">Show more (${items.length - shown.length} more)</button>` : "");
    if ($("crop-news-more")) $("crop-news-more").addEventListener("click", () => { state.newsShown += 30; renderNews(); });
  }

  // ------------------------------------------------------------------
  // Selection, links (#country=india&crop=rice) and controls
  // ------------------------------------------------------------------
  function fillCurrencies() {
    const sel = $("crop-currency");
    const rates = (state.data.fx && state.data.fx.rates) || {};
    const used = [...new Set(Object.values(INFO.currencies))].filter((c) => c === "USD" || rates[c]);
    const label = (c) => `${c} · ${curName(c)}`;
    sel.innerHTML = `<option value="">Auto (${currency(true)})</option>`
      + used.sort((a, b) => curName(a).localeCompare(curName(b))).map((c) => `<option value="${c}">${escapeHtml(label(c))}</option>`).join("");
    sel.value = used.includes(state.cur) ? state.cur : "";
    sel.disabled = used.length < 2;
  }

  function writeHash() {
    const params = new URLSearchParams();
    if (state.country) params.set("country", state.country);
    if (state.crop) params.set("crop", state.crop);
    if (state.cur) params.set("cur", state.cur);
    history.replaceState(null, "", params.toString() ? `#${params}` : window.location.pathname);
  }

  function syncControls() {
    $("crop-country").value = state.country;
    $("crop-currency").options[0].textContent = `Auto (${currency(true)})`;
    const available = state.country ? new Set(INFO.regions.filter((r) => r.country === state.country).map((r) => r.crop)) : null;
    document.querySelectorAll("#crop-chips .chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.crop === state.crop);
      chip.hidden = Boolean(available && chip.dataset.crop && !available.has(chip.dataset.crop));
    });
  }

  function select(country, crop, { scroll = true } = {}) {
    state.country = country || "";
    state.crop = crop || "";
    if (state.country) state.lastCountry = state.country;
    state.newsShown = 30;
    writeHash();
    syncControls();
    filterTable();
    renderPriceCards();
    renderDetail();
    renderNews();
    if (scroll && (state.country || state.crop)) $("crop-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("crop-country").addEventListener("change", (e) => {
    const country = e.target.value;
    const crops = INFO.regions.filter((r) => r.country === country).map((r) => r.crop);
    select(country, crops.includes(state.crop) ? state.crop : (crops[0] || ""), { scroll: false });
  });
  document.querySelectorAll("#crop-chips .chip").forEach((chip) => chip.addEventListener("click", () => select(state.country, chip.dataset.crop, { scroll: false })));
  document.querySelectorAll("#crop-table tbody tr").forEach((tr) => {
    const go = () => select(tr.dataset.country, tr.dataset.crop);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
  document.querySelectorAll(".price-card").forEach((card) => card.addEventListener("click", () => select("", card.dataset.crop)));
  $("crop-currency").addEventListener("change", (e) => {
    state.cur = e.target.value;
    writeHash();
    renderPriceCards();
    renderDetail();
  });
  let searchTimer;
  $("crop-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value; state.newsShown = 30; filterTable(); renderNews(); }, 200);
  });
  window.addEventListener("resize", () => {
    if ($("price-chart") && state.data.prices[state.crop || ""]) priceChart($("price-chart"), state.data.prices[state.crop]);
  });

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  const params = new URLSearchParams(window.location.hash.slice(1));
  const start = {
    country: COUNTRIES[params.get("country")] ? params.get("country") : "india",
    crop: INFO.crops[params.get("crop")] ? params.get("crop") : (params.get("country") ? "" : "rice"),
  };
  state.cur = /^[A-Z]{3}$/.test(params.get("cur") || "") ? params.get("cur") : "";
  select(start.country, start.crop, { scroll: false });

  Promise.allSettled([
    getJson("crops.json", "/api/crops").then((d) => { state.data = { prices: d.prices || {}, rain: d.rain || {}, fx: d.fx || null }; }),
    getJson("enso.json", "/api/enso").then((d) => { state.enso = d; }),
    getJson("news.json", "/api/news").then((d) => { state.news = d; }),
  ]).then((results) => {
    if (results[0].status === "rejected") toast("Crop prices and rainfall are not available right now.");
    fillRainCells();
    fillCurrencies();
    renderPriceCards();
    renderDetail();
    renderNews();
  });
})();
