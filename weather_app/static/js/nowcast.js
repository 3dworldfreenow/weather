/* Radar nowcasting engine: predicts where rain will be in the next 1–2 hours by
 * measuring how rain areas moved between recent radar images and moving the latest
 * image further along that motion ("extrapolation nowcasting", the method behind
 * most rain-radar forecasts for the next hour).
 *
 * Grids are { w, h, data: Float32Array } with rain intensity 0..1 (0 = dry), row by row.
 * Works in the browser (window.Nowcast) and in Node (module.exports) for tests.
 *
 * Limits: storms are assumed to keep their current motion and strength; new storms
 * forming or storms dying out are not predicted.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Nowcast = factory();
})(typeof self !== "undefined" ? self : this, () => {
  "use strict";

  const grid = (w, h, data) => ({ w, h, data: data || new Float32Array(w * h) });

  // Average blocks of f×f pixels (smooths noise and speeds up motion search).
  function downsample(g, f) {
    const w = Math.floor(g.w / f), h = Math.floor(g.h / f);
    const out = grid(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += g.data[(y * f + j) * g.w + x * f + i];
        out.data[y * w + x] = s / (f * f);
      }
    }
    return out;
  }

  function at(g, x, y) {
    if (x < 0 || y < 0 || x > g.w - 1 || y > g.h - 1) return 0;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const d = g.data, w = g.w;
    return (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx) * (1 - fy) + (d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx) * fy;
  }

  /* Motion between two images, block by block: for every block of `curr` that has rain,
   * find the shift (dx, dy) that best matches `prev`, i.e. rain moved by (dx, dy) pixels.
   * Blocks without rain get the overall (median) motion; the field is then smoothed. */
  function motionField(prev, curr, opts = {}) {
    const block = opts.block || 16, search = opts.search || 8, minRain = opts.minRain || 0.02;
    const bw = Math.ceil(curr.w / block), bh = Math.ceil(curr.h / block);
    const u = new Float32Array(bw * bh), v = new Float32Array(bw * bh), ok = new Uint8Array(bw * bh);
    const found = [];
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const x0 = bx * block, y0 = by * block, x1 = Math.min(curr.w, x0 + block), y1 = Math.min(curr.h, y0 + block);
        let rain = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rain += curr.data[y * curr.w + x];
        if (rain / ((x1 - x0) * (y1 - y0)) < minRain) continue;
        // Mean absolute difference between this block and `prev` shifted by (dx, dy).
        const cost = (dx, dy) => {
          let c = 0, n = 0;
          for (let y = y0; y < y1; y++) {
            const py = y - dy;
            if (py < 0 || py >= prev.h) continue;
            for (let x = x0; x < x1; x++) {
              const px = x - dx;
              if (px < 0 || px >= prev.w) continue;
              c += Math.abs(curr.data[y * curr.w + x] - prev.data[py * prev.w + px]);
              n++;
            }
          }
          return n < (x1 - x0) * (y1 - y0) * 0.5 ? Infinity : c / n;
        };
        let best = Infinity, bdx = 0, bdy = 0;
        for (let dy = -search; dy <= search; dy++) {
          for (let dx = -search; dx <= search; dx++) {
            const c = cost(dx, dy) + 1e-4 * (dx * dx + dy * dy); // prefer smaller motion when equally good
            if (c < best) { best = c; bdx = dx; bdy = dy; }
          }
        }
        // Sub-pixel refinement: fit a parabola through the costs either side of the best shift.
        const refine = (cm, c0, cp) => {
          const den = cm - 2 * c0 + cp;
          return Number.isFinite(den) && den > 1e-9 ? Math.max(-0.5, Math.min(0.5, (cm - cp) / (2 * den))) : 0;
        };
        const c0 = cost(bdx, bdy);
        const fx = refine(cost(bdx - 1, bdy), c0, cost(bdx + 1, bdy));
        const fy = refine(cost(bdx, bdy - 1), c0, cost(bdx, bdy + 1));
        bdx += fx; bdy += fy;
        const i = by * bw + bx;
        u[i] = bdx; v[i] = bdy; ok[i] = 1;
        found.push([bdx, bdy]);
      }
    }
    const median = (k) => {
      if (!found.length) return 0;
      const s = found.map((f) => f[k]).sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const gu = median(0), gv = median(1);
    for (let i = 0; i < u.length; i++) if (!ok[i]) { u[i] = gu; v[i] = gv; }
    // Smooth (3×3 mean, twice) so neighbouring blocks move together.
    const smooth = (a) => {
      const out = new Float32Array(a.length);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          let s = 0, n = 0;
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
            const xx = x + i, yy = y + j;
            if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) { s += a[yy * bw + xx]; n++; }
          }
          out[y * bw + x] = s / n;
        }
      }
      return out;
    };
    let su = u, sv = v;
    for (let k = 0; k < 2; k++) { su = smooth(su); sv = smooth(sv); }
    return { block, bw, bh, u: su, v: sv, global: { u: gu, v: gv }, blocksWithRain: found.length };
  }

  // Motion (pixels per step) at a pixel, interpolated between block centres.
  function motionAt(field, x, y, scale = 1) {
    const g = { w: field.bw, h: field.bh };
    const fx = Math.max(0, Math.min(g.w - 1, x / scale / field.block - 0.5));
    const fy = Math.max(0, Math.min(g.h - 1, y / scale / field.block - 0.5));
    return { u: at({ ...g, data: field.u }, fx, fy) * scale, v: at({ ...g, data: field.v }, fx, fy) * scale };
  }

  /* The image `steps` time steps ahead: each pixel takes the value found by tracing
   * the motion backwards (semi-Lagrangian advection). `scale` converts the field's pixel
   * size (if it was measured on a downsampled image) to the image's pixels. */
  function advect(g, field, steps, scale = 1) {
    const out = grid(g.w, g.h);
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        let px = x, py = y;
        // Trace back in a few sub-steps so curved motion is followed.
        const sub = Math.max(1, Math.ceil(steps));
        for (let k = 0; k < sub; k++) {
          const m = motionAt(field, px, py, scale);
          px -= (m.u * steps) / sub;
          py -= (m.v * steps) / sub;
        }
        out.data[y * g.w + x] = at(g, px, py);
      }
    }
    return out;
  }

  /* Rain at one point over the coming steps: trace back along the motion and read the
   * latest image, taking the strongest value in a small neighbourhood (radius px) so a
   * near miss still counts. Returns intensities for t = 0, 1, …, maxSteps (in steps). */
  function timelineAt(g, field, x, y, maxSteps, opts = {}) {
    const scale = opts.scale || 1, radius = opts.radius || 2, sub = opts.substeps || 2;
    const out = [];
    let px = x, py = y;
    for (let t = 0; t <= maxSteps * sub; t++) {
      if (t % sub === 0) {
        let best = 0;
        for (let j = -radius; j <= radius; j++) for (let i = -radius; i <= radius; i++) best = Math.max(best, at(g, px + i, py + j));
        out.push(best);
      }
      const m = motionAt(field, px, py, scale);
      px -= m.u / sub;
      py -= m.v / sub;
    }
    return out;
  }

  /* Summary for a place from its timeline (intensity per step). */
  function summarize(timeline, threshold = 0.05) {
    const wet = timeline.map((v) => v >= threshold);
    const peak = Math.max(0, ...timeline);
    if (wet[0]) {
      const stop = wet.indexOf(false);
      return { rainingNow: true, stopsInSteps: stop < 0 ? null : stop, peak };
    }
    const start = wet.indexOf(true);
    if (start < 0) return { rainingNow: false, arrivesInSteps: null, peak: 0 };
    const end = wet.indexOf(false, start);
    return { rainingNow: false, arrivesInSteps: start, lastsSteps: end < 0 ? null : end - start,
      peak: Math.max(...timeline.slice(start, end < 0 ? undefined : end)) };
  }

  /* Nearest rain to a point in the latest image: distance (px) and the pixel. */
  function nearestRain(g, x, y, threshold = 0.05, maxRadius = 400) {
    let best = null;
    const r2max = maxRadius * maxRadius;
    for (let yy = Math.max(0, Math.floor(y - maxRadius)); yy < Math.min(g.h, y + maxRadius); yy += 2) {
      for (let xx = Math.max(0, Math.floor(x - maxRadius)); xx < Math.min(g.w, x + maxRadius); xx += 2) {
        if (g.data[yy * g.w + xx] < threshold) continue;
        const d2 = (xx - x) ** 2 + (yy - y) ** 2;
        if (d2 <= r2max && (!best || d2 < best.d2)) best = { d2, x: xx, y: yy };
      }
    }
    return best ? { distance: Math.sqrt(best.d2), x: best.x, y: best.y } : null;
  }

  return { grid, downsample, sample: at, motionField, motionAt, advect, timelineAt, summarize, nearestRain };
});
