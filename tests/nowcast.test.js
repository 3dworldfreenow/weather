// Run with: node tests/nowcast.test.js  (also run by tests/test_nowcast_js.py)
const assert = require("assert");
const N = require("../weather_app/static/js/nowcast.js");

// A round storm (radius 12 px) moving 3 px right and 1 px down per step on a 200×160 image.
function storm(cx, cy, w = 200, h = 160) {
  const g = N.grid(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - cx, y - cy);
    g.data[y * w + x] = d < 12 ? 0.8 * (1 - d / 14) + 0.1 : 0;
  }
  return g;
}
const prev = storm(40, 60), curr = storm(46, 62); // moved (6, 2) over two steps

// Motion measured over two steps, halved to get per-step motion.
const f2 = N.motionField(prev, curr, { block: 16, search: 10 });
assert(f2.blocksWithRain > 0, "found rain blocks");
const m = N.motionAt(f2, 46, 62);
assert(Math.abs(m.u - 6) < 0.6 && Math.abs(m.v - 2) < 0.6, `motion ${m.u},${m.v}`);
const field = { ...f2, u: f2.u.map((x) => x / 2), v: f2.v.map((x) => x / 2) };

// Ten steps later the storm should be centred near (76, 72).
const next = N.advect(curr, field, 10);
let sx = 0, sy = 0, s = 0;
for (let y = 0; y < next.h; y++) for (let x = 0; x < next.w; x++) { const v = next.data[y * next.w + x]; sx += v * x; sy += v * y; s += v; }
assert(Math.abs(sx / s - 76) < 3 && Math.abs(sy / s - 72) < 3, `advected centre ${sx / s},${sy / s}`);

// A village at (100, 80): the storm edge (radius ~12) reaches it after about (100-46-12)/3 ≈ 13–15 steps.
const tl = N.timelineAt(curr, field, 100, 80, 30, { radius: 1 });
const sum = N.summarize(tl);
assert(!sum.rainingNow && sum.arrivesInSteps >= 11 && sum.arrivesInSteps <= 16, JSON.stringify(sum));
assert(sum.lastsSteps >= 5 && sum.lastsSteps <= 10, `lasts ${sum.lastsSteps}`);

// A place inside the storm now: raining, stops later.
const here = N.summarize(N.timelineAt(curr, field, 46, 62, 30, { radius: 0 }));
assert(here.rainingNow && here.stopsInSteps > 0, JSON.stringify(here));

// A place behind the storm: no rain coming.
assert.strictEqual(N.summarize(N.timelineAt(curr, field, 10, 20, 30, { radius: 1 })).arrivesInSteps, null);

// Nearest rain from the village.
const near = N.nearestRain(curr, 100, 80);
assert(near && near.distance > 40 && near.distance < 50, JSON.stringify(near));

// Fractional motion (2.5 px right, 0.75 px up per step, measured over 3 steps) is measured to within 0.25 px.
const fa = N.motionField(storm(60, 80), storm(67.5, 77.75), { block: 16, search: 10 });
const mf = N.motionAt(fa, 67, 78);
assert(Math.abs(mf.u / 3 - 2.5) < 0.25 && Math.abs(mf.v / 3 + 0.75) < 0.25, `fractional motion ${mf.u / 3},${mf.v / 3}`);

// No rain anywhere: no motion found, nothing arrives.
const dry = N.grid(50, 50);
assert.strictEqual(N.motionField(dry, dry).blocksWithRain, 0);
console.log("nowcast engine: all checks passed");
