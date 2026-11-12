/*
 * burnable.js
 * The thing that burns, as pixels. Two implementations behind one interface:
 *
 *   staged   real stage art (pre-sliced frames or a sheet sliced here). Progress
 *            is continuous: the char front is a moving, feathered mask between
 *            the current stage and the next, the already-burnt part crossfades,
 *            and the shape itself is morphed along the object's centreline so the
 *            final bend is animated instead of cut to.
 *   single   one PNG, burned procedurally with a noise dissolve and a glowing edge.
 *
 * Interface:
 *   width, height     size of the working canvas, in source pixels
 *   nativeAxis        'y' for staged art (authored upright, head at top)
 *                     'x' or 'y' for single (already in display orientation)
 *   thickness         a characteristic thickness in source pixels (sizes the flame)
 *   flameScale
 *   canvas            the composed image for the last update()
 *   update(p, t)      p in 0..1. Returns true if the canvas changed.
 *   front()           {x, y} of the burn front in source pixels
 */

import { clamp, lerp, smoothstep, loadImage, makeCanvas, noise2 } from './util.js';

const LUT_N = 384;      // samples along the centreline
const FEATHER = 0.03;   // softness of the char front, as a fraction of length
const EDGE_ROWS = 4;    // rows drawn beyond the measured ends (antialiasing, rim)

export async function createBurnable(cfg, orientation) {
  if (cfg.type === 'single') return createSingle(cfg, orientation);
  const frames = cfg.type === 'sheet' ? await sliceSheet(cfg) : await loadStages(cfg);
  return createStaged(frames, cfg);
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function loadStages(cfg) {
  const images = await Promise.all(cfg.frames.map(loadImage));
  const w = Math.max(...images.map((i) => i.naturalWidth));
  const h = Math.max(...images.map((i) => i.naturalHeight));
  // Frames should already share a cell. If they do not, anchor bottom centre.
  return images.map((img) => {
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(
      img,
      Math.round((w - img.naturalWidth) / 2),
      h - img.naturalHeight
    );
    return c;
  });
}

/**
 * Slice a left-to-right sheet in the browser. Same registration as
 * tools/slice.py: shared baseline, centred on the unburnt base of each object.
 * The Python tool additionally cleans the matte fringe and removes side halo
 * from a pre-lit first stage, so prefer it for final art.
 */
async function sliceSheet(cfg) {
  const img = await loadImage(cfg.src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const src = makeCanvas(W, H);
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const d = sctx.getImageData(0, 0, W, H).data;
  const on = (x, y) => d[(y * W + x) * 4 + 3] > 20;

  const runs = [];
  let start = -1;
  for (let x = 0; x <= W; x++) {
    let any = false;
    if (x < W) for (let y = 0; y < H; y++) if (on(x, y)) { any = true; break; }
    if (any && start < 0) start = x;
    if (!any && start >= 0) { runs.push([start, x - 1]); start = -1; }
  }
  if (runs.length < 2) throw new Error('Sheet needs at least two stages separated by transparent columns.');

  const boxes = runs.map(([x0, x1]) => {
    let y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = x0; x <= x1; x++) if (on(x, y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; break; }
    }
    // centre of the lowest 8%: the unburnt base
    const bandTop = Math.floor(y1 - (y1 - y0) * 0.08);
    let bx0 = x1, bx1 = x0;
    for (let y = bandTop; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (on(x, y)) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
    }
    return { x0, x1, y0, y1, cx: (bx0 + bx1) / 2 };
  });

  const PAD = 6;
  const bottom = Math.max(...boxes.map((b) => b.y1));
  const half = Math.ceil(Math.max(...boxes.map((b) => Math.max(b.cx - b.x0, b.x1 - b.cx)))) + PAD;
  const tops = (cfg.firstHasFlame ? boxes.slice(1) : boxes).map((b) => b.y0);
  const top = Math.min(...tops) - PAD;
  const cw = half * 2 + 1;
  const ch = bottom + PAD + 1 - top;

  const cells = boxes.map((b) => {
    const c = makeCanvas(cw, ch);
    const cx = c.getContext('2d', { willReadFrequently: true });
    const rw = b.x1 - b.x0 + 1;
    // Only this object's own columns are copied, so neighbours never leak in.
    cx.drawImage(src, b.x0, top, rw, ch, b.x0 - (Math.round(b.cx) - half), 0, rw, ch);
    return c;
  });

  if (cfg.firstHasFlame) {
    // The crop above cut the flame off at the top of the head; its pale skirt
    // still wraps the head. Same rule as tools/slice.py: find the head (the
    // saturated rows near the top), keep an ellipse around it plus the stick
    // column, and let everything else go.
    const c = cells[0];
    const cx = c.getContext('2d', { willReadFrequently: true });
    const img = cx.getImageData(0, 0, cw, ch);
    const px = img.data;
    const solid = (x, y) => px[(y * cw + x) * 4 + 3] > 200;

    const widths = [];
    for (let y = ch >> 1; y < ch; y++) {
      let n = 0;
      for (let x = 0; x < cw; x++) if (solid(x, y)) n++;
      if (n) widths.push(n);
    }
    widths.sort((p, q) => p - q);
    const stickW = widths[widths.length >> 1] || 12;

    let headTop = -1, headBottom = -1;
    for (let y = 0; y < ch * 0.4; y++) {
      let sat = 0, n = 0;
      for (let x = 0; x < cw; x++) {
        if (!solid(x, y)) continue;
        const i = (y * cw + x) * 4;
        const mx = Math.max(px[i], px[i + 1], px[i + 2]);
        const mn = Math.min(px[i], px[i + 1], px[i + 2]);
        sat += mx ? (mx - mn) / mx : 0;
        n++;
      }
      if (n && sat / n > 0.3) { if (headTop < 0) headTop = y; headBottom = y; }
    }
    if (headTop >= 0) {
      const cy = (headTop + headBottom) / 2;
      const ry = (headBottom - headTop) / 2 + 1.5;
      const rx = Math.max(stickW / 2 + 2.5, ry * 0.98);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const i = (y * cw + x) * 4;
          if (!px[i + 3]) continue;
          if (y >= cy && Math.abs(x - half) <= stickW / 2 + 3) continue; // the stick
          const d = Math.hypot((x - half) / rx, (y - cy) / ry);
          px[i + 3] *= clamp((1.06 - d) / 0.08);                         // the head, soft edged
        }
      }
      cx.putImageData(img, 0, 0);
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ */
/* Staged burn                                                         */
/* ------------------------------------------------------------------ */

function analyse(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;

  const pm = new Float32Array(w * h * 4); // premultiplied, 0..255
  const cxRaw = new Float32Array(h).fill(NaN);
  const wid = new Float32Array(h);
  const dark = new Uint8Array(h);
  let top = -1;
  let bottom = -1;

  for (let y = 0; y < h; y++) {
    let sx = 0, n = 0, dk = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = d[i + 3];
      const k = a / 255;
      pm[i] = d[i] * k;
      pm[i + 1] = d[i + 1] * k;
      pm[i + 2] = d[i + 2] * k;
      pm[i + 3] = a;
      if (a > 128) {
        n++;
        sx += x;
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 70) dk++;
      }
    }
    if (n > 0) {
      if (top < 0) top = y;
      bottom = y;
      cxRaw[y] = sx / n;
      wid[y] = n;
      dark[y] = dk / n > 0.5 ? 1 : 0;
    }
  }
  if (top < 0) throw new Error('A stage image is empty.');

  // carry centre across any empty rows inside the object, then smooth
  for (let y = top + 1; y <= bottom; y++) if (Number.isNaN(cxRaw[y])) cxRaw[y] = cxRaw[y - 1];
  const cx = new Float32Array(h);
  for (let y = top; y <= bottom; y++) {
    let s = 0, n = 0;
    for (let k = -4; k <= 4; k++) {
      const yy = y + k;
      if (yy >= top && yy <= bottom) { s += cxRaw[yy]; n++; }
    }
    cx[y] = s / n;
  }

  // arc length along the centreline, so a curled stage is parameterised correctly
  const cum = new Float32Array(h);
  for (let y = top + 1; y <= bottom; y++) cum[y] = cum[y - 1] + Math.hypot(1, cx[y] - cx[y - 1]);
  const total = cum[bottom] || 1;

  const lutY = new Float32Array(LUT_N);
  const lutX = new Float32Array(LUT_N);
  let y = top;
  for (let j = 0; j < LUT_N; j++) {
    const target = (j / (LUT_N - 1)) * total;
    while (y < bottom - 1 && cum[y + 1] < target) y++;
    const span = cum[y + 1] - cum[y] || 1;
    const f = clamp((target - cum[y]) / span);
    lutY[j] = y + f;
    lutX[j] = lerp(cx[y], cx[Math.min(bottom, y + 1)], f);
  }

  // char front: the last dark row, if there is a real run of them
  let darkCount = 0;
  let lastDark = top;
  for (let yy = top; yy <= bottom; yy++) if (dark[yy]) { darkCount++; lastDark = yy; }
  const charS = darkCount < Math.max(6, (bottom - top) * 0.03) ? 0 : cum[lastDark] / total;

  // thickness: median width of the lowest 30% (the unburnt stick)
  const widths = [];
  for (let yy = Math.floor(bottom - (bottom - top) * 0.3); yy <= bottom; yy++) if (wid[yy]) widths.push(wid[yy]);
  widths.sort((a, b) => a - b);
  const thickness = widths[widths.length >> 1] || w * 0.2;

  return { pm, lutX, lutY, charS, thickness, top, bottom };
}

function createStaged(frameCanvases, cfg) {
  const w = frameCanvases[0].width;
  const h = frameCanvases[0].height;
  const frames = frameCanvases.map(analyse);
  const last = frames.length - 1;

  const fronts = frames.map((f, i) =>
    Array.isArray(cfg.charFronts) && typeof cfg.charFronts[i] === 'number' ? cfg.charFronts[i] : f.charS
  );
  fronts[0] = 0;
  for (let i = 1; i <= last; i++) fronts[i] = Math.max(fronts[i], fronts[i - 1] + 1e-4);
  const finalFront = fronts[last];

  const out = makeCanvas(w, h);
  const octx = out.getContext('2d');
  const image = octx.createImageData(w, h);
  const acc = new Float32Array(w * 4);
  const ym = new Float32Array(LUT_N);
  const xm = new Float32Array(LUT_N);
  const frontPt = { x: frames[0].lutX[0], y: frames[0].lutY[0] };
  // The flame is anchored at the char front, but never closer to the tip than
  // about one head radius: it stands on the head, it does not hang off its end.
  const flameMinS = clamp((frames[0].thickness * 0.85) / Math.max(1, frames[0].bottom - frames[0].top), 0, 0.2);
  const minStep = 1 / (h * 6);
  let lastP = null;

  function drawFrame(i) {
    octx.clearRect(0, 0, w, h);
    octx.drawImage(frameCanvases[i], 0, 0);
  }

  /** Bilinear-sample one source row into the accumulator, shifted and weighted. */
  function addRow(pm, ySrc, shift, weight) {
    if (weight <= 0.002) return;
    const y0 = Math.floor(ySrc);
    const fy = ySrc - y0;
    const xi = Math.floor(-shift);
    const fx = -shift - xi;
    for (let r = 0; r < 2; r++) {
      const yy = y0 + r;
      const wy = (r === 0 ? 1 - fy : fy) * weight;
      if (wy <= 0 || yy < 0 || yy >= h) continue;
      const base = yy * w * 4;
      const w0 = wy * (1 - fx);
      const w1 = wy * fx;
      for (let xd = 0; xd < w; xd++) {
        const x0 = xd + xi;
        const o = xd * 4;
        if (x0 >= 0 && x0 < w) {
          const i = base + x0 * 4;
          acc[o] += pm[i] * w0; acc[o + 1] += pm[i + 1] * w0; acc[o + 2] += pm[i + 2] * w0; acc[o + 3] += pm[i + 3] * w0;
        }
        const x1 = x0 + 1;
        if (w1 > 0 && x1 >= 0 && x1 < w) {
          const i = base + x1 * 4;
          acc[o] += pm[i] * w1; acc[o + 1] += pm[i + 1] * w1; acc[o + 2] += pm[i + 2] * w1; acc[o + 3] += pm[i + 3] * w1;
        }
      }
    }
  }

  /**
   * Compose stage A burning into stage B.
   *   F   char front, 0..1 along the centreline
   *   cK  where A's own char ends
   *   t   0..1 through this segment
   *   m   0..1 shape morph from A's centreline to B's
   */
  function compose(A, B, F, cK, t, m) {
    for (let j = 0; j < LUT_N; j++) {
      ym[j] = A.lutY[j] + (B.lutY[j] - A.lutY[j]) * m;
      xm[j] = A.lutX[j] + (B.lutX[j] - A.lutX[j]) * m;
    }
    const data = image.data;
    data.fill(0);
    const yStart = Math.max(0, Math.floor(ym[0]) - EDGE_ROWS);
    const yEnd = Math.min(h - 1, Math.ceil(ym[LUT_N - 1]) + EDGE_ROWS);
    const gate = Math.min(1, t / 0.08);       // no pop at the start of a segment
    const settle = smoothstep(0.8, 1, t);     // B takes over completely by the end
    let j = 0;

    for (let yd = yStart; yd <= yEnd; yd++) {
      let s, yA, yB, xA, xB, xM;
      if (yd <= ym[0]) {
        const dy = ym[0] - yd;
        s = 0; yA = A.lutY[0] - dy; yB = B.lutY[0] - dy;
        xA = A.lutX[0]; xB = B.lutX[0]; xM = xm[0];
      } else if (yd >= ym[LUT_N - 1]) {
        const dy = yd - ym[LUT_N - 1];
        const e = LUT_N - 1;
        s = 1; yA = A.lutY[e] + dy; yB = B.lutY[e] + dy;
        xA = A.lutX[e]; xB = B.lutX[e]; xM = xm[e];
      } else {
        while (j < LUT_N - 2 && ym[j + 1] < yd) j++;
        const f = clamp((yd - ym[j]) / (ym[j + 1] - ym[j] || 1));
        s = (j + f) / (LUT_N - 1);
        yA = lerp(A.lutY[j], A.lutY[j + 1], f); yB = lerp(B.lutY[j], B.lutY[j + 1], f);
        xA = lerp(A.lutX[j], A.lutX[j + 1], f); xB = lerp(B.lutX[j], B.lutX[j + 1], f);
        xM = lerp(xm[j], xm[j + 1], f);
      }

      // How much of B shows on this row:
      //   above A's old front  crossfade (t)
      //   old front .. F       B, fully: this is the newly charred wood
      //   beyond F             A, still unburnt, with a feathered edge
      let a = lerp(t, gate, smoothstep(cK - FEATHER, cK, s)) * (1 - smoothstep(F, F + FEATHER, s));
      a += (1 - a) * settle;

      acc.fill(0);
      addRow(A.pm, yA, xM - xA, 1 - a);
      addRow(B.pm, yB, xM - xB, a);

      const rowBase = yd * w * 4;
      for (let xd = 0; xd < w; xd++) {
        const o = xd * 4;
        const al = acc[o + 3];
        if (al < 0.5) continue;
        const k = 255 / al;
        const i = rowBase + o;
        data[i] = acc[o] * k; data[i + 1] = acc[o + 1] * k; data[i + 2] = acc[o + 2] * k; data[i + 3] = al;
      }
    }
    octx.putImageData(image, 0, 0);

    const fj = clamp(Math.max(F, flameMinS)) * (LUT_N - 1);
    const j0 = Math.min(LUT_N - 2, Math.floor(fj));
    frontPt.x = lerp(xm[j0], xm[j0 + 1], fj - j0);
    frontPt.y = lerp(ym[j0], ym[j0 + 1], fj - j0);
  }

  function restFront() {
    const f = frames[0];
    const fj = flameMinS * (LUT_N - 1);
    const j0 = Math.min(LUT_N - 2, Math.floor(fj));
    frontPt.x = lerp(f.lutX[j0], f.lutX[j0 + 1], fj - j0);
    frontPt.y = lerp(f.lutY[j0], f.lutY[j0 + 1], fj - j0);
  }

  function update(p) {
    p = clamp(p);
    if (lastP !== null && Math.abs(p - lastP) < minStep && !(p === 0 || p === 1) ) return false;
    if (lastP === p) return false;
    lastP = p;

    if (p <= 0) {
      drawFrame(0);
      restFront();
      return true;
    }
    if (p >= 1) {
      drawFrame(last);
      const fj = clamp(finalFront) * (LUT_N - 1);
      const j0 = Math.min(LUT_N - 2, Math.floor(fj));
      frontPt.x = lerp(frames[last].lutX[j0], frames[last].lutX[j0 + 1], fj - j0);
      frontPt.y = lerp(frames[last].lutY[j0], frames[last].lutY[j0 + 1], fj - j0);
      return true;
    }

    const F = p * finalFront;
    let k = 0;
    while (k < last - 1 && F >= fronts[k + 1]) k++;
    const t = clamp((F - fronts[k]) / (fronts[k + 1] - fronts[k]));
    // Shape: every segment eases A's centreline into B's. In the last segment
    // that easing is the bend into the curled stage.
    const m = k === last - 1 ? smoothstep(cfg.bendStart ?? 0.2, 1, t) : t;
    compose(frames[k], frames[k + 1], F, fronts[k], t, m);
    return true;
  }

  update(0);

  return {
    width: w,
    height: h,
    nativeAxis: 'y',
    thickness: frames[0].thickness,
    flameScale: cfg.flameScale ?? 1,
    canvas: out,
    fronts,
    update,
    front: () => frontPt,
    invalidate() { lastP = null; },
  };
}

/* ------------------------------------------------------------------ */
/* Single image, procedural burn                                       */
/* ------------------------------------------------------------------ */

async function createSingle(cfg, orientation) {
  const img = await loadImage(cfg.src);
  const max = cfg.maxSize ?? 520;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  // The axis the burn travels along, in the image's own space.
  //   'y'  top to bottom. Art authored upright; in the horizontal layout the
  //        view turns it a quarter, so the top becomes the left end.
  //   'x'  left to right. Art authored as a bar; never rotated.
  // Unset: follow the layout, no rotation.
  const axis = cfg.axis === 'x' || cfg.axis === 'y' ? cfg.axis : orientation === 'horizontal' ? 'x' : 'y';

  const out = makeCanvas(w, h);
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.drawImage(img, 0, 0, w, h);
  const srcData = octx.getImageData(0, 0, w, h).data.slice();
  const image = octx.createImageData(w, h);

  // Fractal noise field, computed once.
  const ns = cfg.noiseScale ?? 0.035;
  const field = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      field[y * w + x] =
        0.6 * noise2(x * ns, y * ns) + 0.28 * noise2(x * ns * 2.7 + 9, y * ns * 2.7 + 4) + 0.12 * noise2(x * ns * 7 + 3, y * ns * 7 + 8);
    }
  }

  // Centre and extent of the object across the burn axis, per step along it.
  const len = axis === 'x' ? w : h;
  const across = axis === 'x' ? h : w;
  const centre = new Float32Array(len).fill(across / 2);
  const extents = [];
  for (let u = 0; u < len; u++) {
    let lo = across, hi = -1, sum = 0, n = 0;
    for (let v = 0; v < across; v++) {
      const x = axis === 'x' ? u : v;
      const y = axis === 'x' ? v : u;
      if (srcData[(y * w + x) * 4 + 3] > 128) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; n++; }
    }
    if (n) { centre[u] = axis === 'x' ? lo + (hi - lo) * 0.25 : sum / n; extents.push(hi - lo + 1); }
  }
  extents.sort((a, b) => a - b);
  const thickness = clamp((extents[extents.length >> 1] || across) * 0.3, 8, across);

  const amount = cfg.noiseAmount ?? 0.07;
  const edge = cfg.edgeWidth ?? 0.035;
  const charW = cfg.charWidth ?? 0.16;
  const frontPt = { x: 0, y: 0 };
  let lastP = null;
  let lastT = -1;

  function update(p, tSec = 0) {
    p = clamp(p);
    // The ember shimmers, so refresh about ten times a second even if p is still.
    if (lastP !== null && Math.abs(p - lastP) < 1 / (len * 4) && Math.abs(tSec - lastT) < 0.1) return false;
    lastP = p;
    lastT = tSec;

    const f = lerp(-amount - 0.005, 1 + amount + edge + charW, p);
    const data = image.data;
    const shimmer = 0.85 + 0.15 * Math.sin(tSec * 9.0);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = srcData[i + 3];
        if (a === 0) { data[i + 3] = 0; continue; }
        const u = (axis === 'x' ? x / w : y / h) + field[y * w + x] * amount;
        const dd = f - u;
        if (p <= 0 || dd < 0) {
          data[i] = srcData[i]; data[i + 1] = srcData[i + 1]; data[i + 2] = srcData[i + 2]; data[i + 3] = a;
        } else if (dd < edge) {
          // glowing edge: pale at the very front, amber, then a dying ember
          const k = dd / edge;
          const hot = (1 - k) * shimmer;
          data[i] = lerp(120, 251, hot);
          data[i + 1] = lerp(48, 226, hot * hot);
          data[i + 2] = lerp(14, 150, hot * hot * hot);
          data[i + 3] = a;
        } else {
          // char, thinning to nothing
          const k = clamp((dd - edge) / charW);
          data[i] = srcData[i] * 0.07; data[i + 1] = srcData[i + 1] * 0.06; data[i + 2] = srcData[i + 2] * 0.06;
          data[i + 3] = a * (1 - k * k * (3 - 2 * k));
        }
      }
    }
    octx.putImageData(image, 0, 0);

    const u = clamp(Math.round(clamp(f) * (len - 1)), 0, len - 1);
    if (axis === 'x') { frontPt.x = u; frontPt.y = centre[u]; }
    else { frontPt.x = centre[u]; frontPt.y = u; }
    return true;
  }

  update(0);

  return {
    width: w,
    height: h,
    nativeAxis: axis,
    thickness,
    flameScale: cfg.flameScale ?? 1,
    canvas: out,
    update,
    front: () => frontPt,
    invalidate() { lastP = null; },
  };
}
