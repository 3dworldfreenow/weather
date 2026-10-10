/* Browser-only implementation of the /api/* endpoints, used by the static
 * GitHub Pages demo where no Flask server runs.
 *
 * Satellite layers, El Niño data and the news feed are read from data/*.json, which a
 * scheduled GitHub Actions job builds with the same Python code as the server
 * (scripts/build_static.py).
 */
(() => {
  "use strict";

  const cache = new Map();
  async function cached(key, ttlMs, factory) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await factory();
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  async function getJson(path, params) {
    const u = new URL(path, document.baseURI);
    Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Data not available yet (${res.status})`);
    return res.json();
  }

  // Bust the browser cache every 5 minutes so new builds are picked up.
  const dataFile = (name) => cached(`file:${name}`, 300e3,
    () => getJson(`data/${name}`, { v: Math.floor(Date.now() / 300e3) }));

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

  const enso = () => dataFile("enso.json");
  const news = () => dataFile("news.json");

  const ROUTES = { "/api/satellites": satellites, "/api/enso": enso, "/api/news": news };

  window.StaticApi = {
    handle(path, params) {
      const fn = ROUTES[path];
      if (!fn) return Promise.reject(new Error(`No static handler for ${path}`));
      return fn(params || {});
    },
  };
})();
