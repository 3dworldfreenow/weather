/* Heavy radar work off the main thread, so the map and animations stay smooth.
 *
 * { kind: "predict", id, w, h, first, mid, now (Float32Array), options }
 *   → { id, field, frames: [{ minutes, url | rgba, w, h }] }   (nowcast.js predict)
 * { kind: "tile", id, url, ramp, threshold, blur }
 *   → { id, bitmap }   a RainViewer tile redrawn in our colours with soft edges
 * Errors come back as { id, error }.
 */
importScripts("nowcast.js");

// Colour for each RainViewer pixel colour (cached: tiles use few distinct colours).
const colors = new Map();
function recolor(r, g, b, a, ramp, threshold) {
  const key = ((r << 16) | (g << 8) | b) * 256 + a;
  let c = colors.get(key);
  if (!c) {
    const v = Nowcast.intensity(Nowcast.decodeColor(r, g, b, a));
    c = v < threshold ? [0, 0, 0, 0] : Array.from(Nowcast.colorize({ w: 1, h: 1, data: [v] }, ramp, 0));
    colors.set(key, c);
  }
  return c;
}

async function tile({ url, ramp, threshold, blur }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Radar tile ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const src = new OffscreenCanvas(bmp.width, bmp.height);
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(bmp, 0, 0);
  const img = sctx.getImageData(0, 0, bmp.width, bmp.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const c = recolor(d[i], d[i + 1], d[i + 2], d[i + 3], ramp, threshold);
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
  }
  sctx.putImageData(img, 0, 0);
  if (!blur) return src.transferToImageBitmap();
  const out = new OffscreenCanvas(bmp.width, bmp.height);
  const octx = out.getContext("2d");
  octx.filter = `blur(${blur}px)`; // soft edges (ignored where unsupported)
  octx.drawImage(src, 0, 0);
  // Keep a sharp 3-px border so neighbouring tiles join without faint seams.
  octx.filter = "none";
  const W = bmp.width, H = bmp.height, B = 3;
  octx.clearRect(0, 0, W, B); octx.clearRect(0, H - B, W, B); octx.clearRect(0, 0, B, H); octx.clearRect(W - B, 0, B, H);
  octx.drawImage(src, 0, 0, W, B, 0, 0, W, B);
  octx.drawImage(src, 0, H - B, W, B, 0, H - B, W, B);
  octx.drawImage(src, 0, 0, B, H, 0, 0, B, H);
  octx.drawImage(src, W - B, 0, B, H, W - B, 0, B, H);
  return out.transferToImageBitmap();
}

async function predict({ w, h, first, mid, now, options }) {
  const g = (a) => Nowcast.grid(w, h, a);
  const { field, frames } = Nowcast.predict(g(first), g(mid), g(now), options);
  // Encode the images here too when the browser allows it (OffscreenCanvas).
  if (typeof OffscreenCanvas !== "undefined") {
    for (const fr of frames) {
      const canvas = new OffscreenCanvas(fr.w, fr.h);
      canvas.getContext("2d").putImageData(new ImageData(fr.rgba, fr.w, fr.h), 0, 0);
      fr.url = URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
      delete fr.rgba;
    }
  }
  return { field, frames };
}

self.onmessage = async (e) => {
  const { id, kind } = e.data;
  try {
    if (kind === "tile") {
      const bitmap = await tile(e.data);
      self.postMessage({ id, bitmap }, [bitmap]);
    } else {
      const { field, frames } = await predict(e.data);
      self.postMessage({ id, field, frames }, frames.filter((f) => f.rgba).map((f) => f.rgba.buffer));
    }
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
