/* News page: every El Niño item from the free sources, with filters by type,
   country, topic, crop, language and search, a video player and the source list. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const PAGE_SIZE = 40;

  const INFO = JSON.parse($("news-info").textContent);
  const THEMES = Object.fromEntries(INFO.themes.map((t) => [t.id, t]));
  const STATIC_SITE = Boolean(window.APP_CONFIG && window.APP_CONFIG.static);
  const KINDS = {
    news: { icon: "📰", label: "News", many: "News" },
    report: { icon: "🆘", label: "Report", many: "Reports" },
    science: { icon: "🔬", label: "Science", many: "Science" },
    paper: { icon: "📄", label: "Research", many: "Research" },
    discussion: { icon: "💬", label: "Discussion", many: "Discussions" },
    podcast: { icon: "🎧", label: "Podcast", many: "Podcasts" },
    video: { icon: "▶️", label: "Video", many: "Videos" },
  };
  const SOURCE_GROUPS = [
    ["news", "🔎", "News searches"], ["publisher", "🗞️", "Newspapers by country"], ["report", "🆘", "Humanitarian reports"],
    ["science", "🔬", "Agencies and science"], ["paper", "📄", "Research"], ["discussion", "💬", "Discussions"],
    ["podcast", "🎧", "Podcasts"], ["video", "▶️", "Video channels"],
  ];
  const FILTERS = ["kind", "q", "country", "theme", "crop", "lang"];
  const state = { data: null, shown: PAGE_SIZE, kind: "", q: "", country: "", theme: "", crop: "", lang: "" };

  function timeAgo(iso) {
    if (!iso) return "";
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (mins < 0) return new Date(iso).toLocaleDateString();
    if (mins < 60) return `${Math.max(mins, 1)} min ago`;
    if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
    if (mins < 60 * 24 * 60) return `${Math.round(mins / 1440)} days ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, 4000);
  }

  async function load() {
    const url = STATIC_SITE
      ? new URL(`../data/news.json?v=${Math.floor(Date.now() / 300e3)}`, window.location.href)
      : new URL("/api/news", window.location.origin);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`News not available (${res.status})`);
    return res.json();
  }

  // ------------------------------------------------------------------
  // Filtering
  // ------------------------------------------------------------------
  const kindOf = (a) => a.kind || "news";

  function matches(a, skip) {
    const q = state.q.trim().toLowerCase();
    return (skip === "kind" || !state.kind || kindOf(a) === state.kind)
      && (!state.country || (state.country.startsWith("slug:")
        ? (a.countries || []).includes(state.country.slice(5)) : a.country === state.country.slice(3)))
      && (!state.theme || (a.themes || []).includes(state.theme))
      && (!state.crop || (a.crops || []).includes(state.crop))
      && (!state.lang || a.language === state.lang)
      && (!q || `${a.title} ${a.source || ""} ${a.summary || ""}`.toLowerCase().includes(q));
  }

  function videoMatches(v) {
    const q = state.q.trim().toLowerCase();
    return !state.country && !state.theme && !state.crop && !state.lang
      && (!q || `${v.title} ${v.channel}`.toLowerCase().includes(q));
  }

  function fillSelects() {
    const slugs = {}, editions = {}, langs = {};
    state.data.articles.forEach((a) => {
      (a.countries || []).forEach((c) => { if (INFO.countries[c]) slugs[c] = (slugs[c] || 0) + 1; });
      if (a.country) editions[a.country] = (editions[a.country] || 0) + 1;
      if (a.language) langs[a.language] = (langs[a.language] || 0) + 1;
    });
    const covered = new Set(Object.keys(slugs).map((s) => INFO.countries[s].name));
    const options = [
      ...Object.entries(slugs).map(([s, n]) => [`slug:${s}`, INFO.countries[s].name, n]),
      ...Object.entries(editions).filter(([name]) => !covered.has(name)).map(([name, n]) => [`ed:${name}`, name, n]),
    ].sort((a, b) => a[1].localeCompare(b[1]));
    $("news-country").innerHTML = `<option value="">All countries</option>${options.map(([v, label, n]) =>
      `<option value="${escapeHtml(v)}">${escapeHtml(label)} (${n})</option>`).join("")}`;
    $("news-lang").innerHTML = `<option value="">All languages</option>${Object.entries(langs)
      .sort((a, b) => b[1] - a[1]).map(([l, n]) => `<option value="${escapeHtml(l)}">${escapeHtml(l)} (${n})</option>`).join("")}`;
    // Keep a filter from the link even if nothing matches yet.
    for (const [id, key] of [["news-country", "country"], ["news-lang", "lang"]]) {
      if (state[key] && ![...$(id).options].some((o) => o.value === state[key])) {
        $(id).insertAdjacentHTML("beforeend", `<option value="${escapeHtml(state[key])}">${escapeHtml(state[key].replace(/^(slug|ed):/, ""))} (0)</option>`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function itemHtml(a) {
    const kind = kindOf(a);
    const url = safeUrl(kind === "discussion" ? (a.discussion || a.url) : a.url);
    if (!url) return "";
    const img = safeUrl(a.image);
    const tags = [
      ...(a.themes || []).filter((t) => THEMES[t]).map((t) => `<span class="tag">${THEMES[t].icon} ${escapeHtml(THEMES[t].title)}</span>`),
      ...(a.crops || []).filter((c) => INFO.crops[c]).map((c) => `<span class="tag">${INFO.crops[c].icon} ${escapeHtml(INFO.crops[c].name)}</span>`),
      ...(a.countries || []).filter((c) => INFO.countries[c]).slice(0, 3).map((c) => `<span class="tag">📍 ${escapeHtml(INFO.countries[c].name)}</span>`),
    ].join("");
    const host = new URL(url).hostname;
    return `<a class="news-item gn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
      <div class="gn-body">
        <div class="news-src"><img class="favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">
          <span>${escapeHtml(a.source)}</span>${kind !== "news" ? `<span class="kind-badge k-${kind}">${KINDS[kind].icon} ${KINDS[kind].label}</span>` : ""}</div>
        <div class="news-title">${escapeHtml(a.title)}</div>
        ${a.summary && kind !== "news" ? `<div class="news-summary">${escapeHtml(a.summary)}</div>` : ""}
        <div class="news-meta">${[a.published && timeAgo(a.published), a.country, a.language].filter(Boolean).map(escapeHtml).join(" · ")}</div>
        ${tags ? `<div class="news-tags">${tags}</div>` : ""}
      </div>
      ${img ? `<img class="gn-thumb" src="${escapeHtml(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
    </a>`;
  }

  function videoCard(v) {
    return `<button class="video-card" data-id="${v.id}" data-title="${escapeHtml(v.title)}">
      <span class="thumb"><img src="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" alt="" loading="lazy"></span>
      <div class="vt">${escapeHtml(v.title)}</div>
      <div class="vm">${escapeHtml(v.channel)}${v.published ? ` · ${escapeHtml(timeAgo(v.published))}` : ""}</div>
    </button>`;
  }

  function renderVideos(target, videos) {
    const latest = videos.filter((v) => !v.explainer);
    const search = safeUrl(state.data.youtube_search);
    target.innerHTML = `
      ${search ? `<a class="yt-search" href="${escapeHtml(search)}" target="_blank" rel="noopener noreferrer">▶ Search all El Niño videos on YouTube</a>` : ""}
      <h2 class="section-title">Latest from weather &amp; climate agencies</h2>
      ${latest.length ? `<div class="video-grid">${latest.map(videoCard).join("")}</div>`
        : '<p class="muted">No new El Niño videos from the agency channels in their latest uploads.</p>'}
      <h2 class="section-title">Explainers</h2>
      <div class="video-grid">${videos.filter((v) => v.explainer).map(videoCard).join("")}</div>`;
    target.querySelectorAll(".video-card").forEach((b) => b.addEventListener("click", () => playVideo(b.dataset.id, b.dataset.title)));
  }

  function renderKindCounts() {
    const counts = {};
    state.data.articles.filter((a) => matches(a, "kind")).forEach((a) => { counts[kindOf(a)] = (counts[kindOf(a)] || 0) + 1; });
    counts.video = state.data.videos.filter((v) => VIDEO_ID.test(v.id) && videoMatches(v)).length;
    const total = Object.entries(counts).filter(([k]) => k !== "video").reduce((s, [, n]) => s + n, 0);
    document.querySelectorAll("#news-kinds .chip").forEach((chip) => {
      const k = chip.dataset.kind;
      const n = k ? counts[k] || 0 : total;
      chip.classList.toggle("active", k === state.kind);
      chip.innerHTML = `${k ? `${KINDS[k].icon} ${KINDS[k].many}` : "All"} <small>${n}</small>`;
    });
  }

  function render() {
    if (!state.data) return;
    renderKindCounts();
    $("news-reset").hidden = !FILTERS.some((k) => state[k]);
    const list = $("news-list");
    if (state.kind === "video") {
      renderVideos(list, state.data.videos.filter((v) => VIDEO_ID.test(v.id) && videoMatches(v)));
      return;
    }
    const items = state.data.articles.filter((a) => matches(a));
    if (!items.length) {
      list.innerHTML = '<p class="muted">Nothing matches these filters right now. Try fewer filters or <button class="link-btn inline" id="news-clear2">clear them</button>.</p>';
      $("news-clear2").addEventListener("click", reset);
      return;
    }
    const shown = items.slice(0, state.shown);
    list.innerHTML = shown.map(itemHtml).join("")
      + (items.length > shown.length ? `<button class="more-btn" id="news-more">Show more (${items.length - shown.length} more)</button>` : "");
    if ($("news-more")) $("news-more").addEventListener("click", () => { state.shown += PAGE_SIZE; render(); });
  }

  function renderStats() {
    const d = state.data;
    const ok = d.sources.filter((s) => s.ok).length;
    $("news-stats").textContent = `${d.articles.length} articles and ${d.videos.length} videos from ${ok} of ${d.sources.length} free sources · updated ${timeAgo(d.updated)}`;
  }

  function renderSources() {
    const d = state.data;
    $("news-sources").innerHTML = SOURCE_GROUPS.map(([kind, icon, title]) => {
      const list = d.sources.filter((s) => s.kind === kind);
      if (!list.length) return "";
      return `<details class="source-group"><summary><b>${icon} ${title}</b>
          <span class="muted">${list.filter((s) => s.ok).length}/${list.length} working · ${list.reduce((n, s) => n + (s.count || 0), 0)} items</span></summary>
        <ul>${list.map((s) => `<li><span class="${s.ok ? "src-ok" : "src-bad"}">${s.ok ? "✓" : "✕"}</span>
          ${safeUrl(s.url) ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>` : escapeHtml(s.name)}
          <span class="muted">${s.ok ? `${s.count} items` : "not available right now"}</span></li>`).join("")}</ul></details>`;
    }).join("");
  }

  // ------------------------------------------------------------------
  // State in the link: #kind=paper&country=slug:india&q=rice
  // ------------------------------------------------------------------
  function writeHash() {
    const p = new URLSearchParams();
    FILTERS.forEach((k) => { if (state[k]) p.set(k, state[k]); });
    history.replaceState(null, "", p.toString() ? `#${p}` : window.location.pathname);
  }

  function readHash() {
    const p = new URLSearchParams(window.location.hash.slice(1));
    FILTERS.forEach((k) => { state[k] = p.get(k) || ""; });
    if (state.kind && !KINDS[state.kind]) state.kind = "";
    if (state.theme && !THEMES[state.theme]) state.theme = "";
    if (state.crop && !INFO.crops[state.crop]) state.crop = "";
    if (state.country && !/^(slug|ed):/.test(state.country)) state.country = INFO.countries[state.country] ? `slug:${state.country}` : "";
  }

  function syncControls() {
    $("news-q").value = state.q;
    $("news-theme").value = state.theme;
    $("news-crop").value = state.crop;
    $("news-country").value = state.country;
    $("news-lang").value = state.lang;
  }

  function update(changes) {
    Object.assign(state, changes);
    state.shown = PAGE_SIZE;
    writeHash();
    render();
  }

  function reset() {
    FILTERS.forEach((k) => { state[k] = ""; });
    syncControls();
    update({});
  }

  document.querySelectorAll("#news-kinds .chip").forEach((chip) => chip.addEventListener("click", () => update({ kind: chip.dataset.kind })));
  $("news-country").addEventListener("change", (e) => update({ country: e.target.value }));
  $("news-theme").addEventListener("change", (e) => update({ theme: e.target.value }));
  $("news-crop").addEventListener("change", (e) => update({ crop: e.target.value }));
  $("news-lang").addEventListener("change", (e) => update({ lang: e.target.value }));
  $("news-reset").addEventListener("click", reset);
  let searchTimer;
  $("news-q").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => update({ q: e.target.value }), 200);
  });

  // ------------------------------------------------------------------
  // Video player (privacy-enhanced YouTube embed)
  // ------------------------------------------------------------------
  function playVideo(id, title) {
    if (!VIDEO_ID.test(id)) return;
    $("video-frame").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0"
      title="${escapeHtml(title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
    $("video-title").textContent = title;
    $("video-modal").hidden = false;
  }
  function closeVideo() {
    $("video-frame").innerHTML = "";
    $("video-modal").hidden = true;
  }
  $("video-close").addEventListener("click", closeVideo);
  $("video-modal").addEventListener("click", (e) => { if (e.target === $("video-modal")) closeVideo(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("video-modal").hidden) closeVideo(); });

  // ------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------
  readHash();
  load().then((d) => {
    d.articles = d.articles || [];
    d.videos = d.videos || [];
    d.sources = d.sources || [];
    state.data = d;
    fillSelects();
    syncControls();
    renderStats();
    renderSources();
    render();
  }).catch((err) => toast(err.message));
})();
