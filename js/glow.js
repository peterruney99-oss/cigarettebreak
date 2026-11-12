/*
 * glow.js
 * Amber glow detector. Classical vision on a small frame, no model.
 *
 * A match flame on a webcam is: a pale, nearly clipped core; an amber to
 * orange-yellow halo around it; small; and never still. Each of those is a test:
 *
 *   colour     pixels in the amber hue range with enough saturation and brightness
 *   core       pale yellow-white pixels (bright, low saturation, warm)
 *   blob       core and halo must be one connected region: not too small, and
 *              not large (a face, a wall, a window)
 *   makeup     a real share of the blob must be core. Warm skin with one
 *              highlight on it is mostly halo and almost no core
 *   contrast   the blob must be clearly brighter than what surrounds it
 *   flicker    the region must change from frame to frame, which a lamp, an
 *              orange object, or a phone screen showing a picture of fire mostly do not
 *
 * The score is the weakest of the tests, each scaled so that "just meets the
 * threshold" is 0.5. The fusion layer applies hysteresis and the one second hold.
 */

import { clamp, rgbToHsv, loadImage, makeCanvas } from './util.js';

export class GlowDetector {
  constructor(cfg) {
    this.cfg = cfg;
    this.hueMin = cfg.hueMin;
    this.hueMax = cfg.hueMax;
    this.seeded = false;
    this.canvas = makeCanvas(cfg.frameWidth, Math.round(cfg.frameWidth * 0.75));
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.mask = new Uint8Array(0);     // 0 none, 1 amber, 2 core
    this.luma = new Uint8Array(0);
    this.prevLuma = new Uint8Array(0);
    this.labels = new Int32Array(0);
    this.stack = new Int32Array(0);
    this.flicker = 0;
    this.result = this.empty();
  }

  empty() {
    return { score: 0, area: 0, amber: 0, core: 0, flicker: 0, contrast: 0, box: null, w: this.canvas.width, h: this.canvas.height };
  }

  /**
   * Seed the hue range from the reference art: take the saturated, bright pixels
   * of the lit match (flame and head), use their 5th to 95th hue percentile, then
   * widen it because a real camera never reproduces an illustrator's amber.
   */
  async seed() {
    try {
      const img = await loadImage(this.cfg.seedImage);
      const c = makeCanvas(img.naturalWidth, img.naturalHeight);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      // the flame and head are the top third of the reference
      const rows = Math.max(1, Math.round(c.height * 0.34));
      const d = x.getImageData(0, 0, c.width, rows).data;
      const hues = [];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 120) continue;
        const [h, s, v] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
        if (s > 0.25 && v > 0.5) hues.push(h);
      }
      if (hues.length >= 40) {
        hues.sort((a, b) => a - b);
        const lo = hues[Math.floor(hues.length * 0.05)];
        const hi = hues[Math.floor(hues.length * 0.95)];
        this.hueMin = Math.max(0, lo - this.cfg.hueWiden);
        this.hueMax = Math.min(75, hi + this.cfg.hueWiden);
        this.seeded = true;
      }
    } catch {
      /* keep the fallback range from config */
    }
  }

  reset() {
    this.flicker = 0;
    this.prevLuma = new Uint8Array(0);
    this.result = this.empty();
  }

  /** Analyse the current video frame. Cheap: about 12k pixels. */
  process(video) {
    const cfg = this.cfg;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return this.result;

    const w = cfg.frameWidth;
    const h = Math.max(8, Math.round((w * vh) / vw));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const n = w * h;
    if (this.mask.length !== n) {
      this.mask = new Uint8Array(n);
      this.luma = new Uint8Array(n);
      this.prevLuma = new Uint8Array(0);
      this.labels = new Int32Array(n);
      this.stack = new Int32Array(n);
    }

    this.ctx.drawImage(video, 0, 0, w, h);
    const d = this.ctx.getImageData(0, 0, w, h).data;
    const { mask, luma } = this;
    const havePrev = this.prevLuma.length === n;

    const rx0 = Math.floor(cfg.roi.x * w);
    const ry0 = Math.floor(cfg.roi.y * h);
    const rx1 = Math.min(w, Math.ceil((cfg.roi.x + cfg.roi.w) * w));
    const ry1 = Math.min(h, Math.ceil((cfg.roi.y + cfg.roi.h) * h));

    mask.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const i = p * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        luma[p] = (r * 77 + g * 150 + b * 29) >> 8;
        if (x < rx0 || x >= rx1 || y < ry0 || y >= ry1) continue;
        const max = r > g ? (r > b ? r : b) : g > b ? g : b;
        if (max < 128) continue; // nothing dim is a flame
        const [hue, s, v] = rgbToHsv(r, g, b);
        if (v >= cfg.coreValMin && s <= cfg.coreSatMax && r >= b) mask[p] = 2;
        else if (hue >= this.hueMin && hue <= this.hueMax && s >= cfg.satMin && v >= cfg.valMin) mask[p] = 1;
      }
    }

    // Connected components (8-neighbour flood fill) over amber and core together.
    const { labels, stack } = this;
    labels.fill(0);
    const roiArea = Math.max(1, (rx1 - rx0) * (ry1 - ry0));
    let best = null;
    let label = 0;
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0; x < rx1; x++) {
        const p0 = y * w + x;
        if (!mask[p0] || labels[p0]) continue;
        label++;
        let top = 0;
        stack[top++] = p0;
        labels[p0] = label;
        let area = 0, amber = 0, core = 0, lumaSum = 0, x0 = x, x1 = x, y0 = y, y1 = y;
        while (top > 0) {
          const p = stack[--top];
          const px = p % w;
          const py = (p - px) / w;
          area++;
          lumaSum += luma[p];
          if (mask[p] === 2) core++; else amber++;
          if (px < x0) x0 = px; if (px > x1) x1 = px;
          if (py < y0) y0 = py; if (py > y1) y1 = py;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = py + dy;
            if (ny < ry0 || ny >= ry1) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = px + dx;
              if (nx < rx0 || nx >= rx1) continue;
              const q = ny * w + nx;
              if (mask[q] && !labels[q]) { labels[q] = label; stack[top++] = q; }
            }
          }
        }
        if (area / roiArea > cfg.maxAreaFraction) continue; // a wall or a window
        const areaTerm = clamp(area / (2 * cfg.minArea));
        const amberTerm = clamp(amber / (2 * cfg.minAmber));
        const coreTerm = cfg.requireCore ? clamp(core / (2 * cfg.minCore)) : 1;
        const mixTerm = cfg.requireCore ? clamp(core / area / (2 * cfg.minCoreFraction)) : 1;
        const shape = Math.min(areaTerm, amberTerm, coreTerm, mixTerm);
        if (!best || shape > best.shape || (shape === best.shape && area > best.area)) {
          best = { shape, area, amber, core, x0, y0, x1, y1, label, mean: lumaSum / area };
        }
      }
    }

    // Flicker: mean absolute luma change inside the (slightly grown) blob box.
    let inst = 0;
    if (best && havePrev) {
      const bx0 = Math.max(0, best.x0 - 1), bx1 = Math.min(w - 1, best.x1 + 1);
      const by0 = Math.max(0, best.y0 - 1), by1 = Math.min(h - 1, best.y1 + 1);
      let sum = 0, count = 0;
      for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
          const p = y * w + x;
          sum += Math.abs(luma[p] - this.prevLuma[p]);
          count++;
        }
      }
      inst = count ? sum / count / 255 : 0;
    }
    this.flicker += (inst - this.flicker) * cfg.flickerSmoothing;

    // Contrast: the blob against the ring of non-blob pixels around it.
    let contrast = 0;
    if (best) {
      const grow = Math.max(3, Math.round(0.5 * Math.max(best.x1 - best.x0, best.y1 - best.y0)));
      const cx0 = Math.max(0, best.x0 - grow), cx1 = Math.min(w - 1, best.x1 + grow);
      const cy0 = Math.max(0, best.y0 - grow), cy1 = Math.min(h - 1, best.y1 + grow);
      let sum = 0, count = 0;
      for (let y = cy0; y <= cy1; y++) {
        for (let x = cx0; x <= cx1; x++) {
          const p = y * w + x;
          if (labels[p] === best.label) continue;
          sum += luma[p];
          count++;
        }
      }
      contrast = count ? (best.mean - sum / count) / 255 : 0;
    }
    if (!havePrev) this.prevLuma = new Uint8Array(n);
    this.prevLuma.set(luma);

    if (!best) {
      this.result = { ...this.empty(), flicker: this.flicker, w, h, roi: [rx0, ry0, rx1, ry1] };
      return this.result;
    }
    const flickerTerm = clamp(this.flicker / (2 * cfg.flickerMin));
    const contrastTerm = cfg.contrastMin > 0 ? clamp(contrast / (2 * cfg.contrastMin)) : 1;
    this.result = {
      score: Math.min(best.shape, flickerTerm, contrastTerm),
      contrast,
      area: best.area,
      amber: best.amber,
      core: best.core,
      flicker: this.flicker,
      box: [best.x0, best.y0, best.x1, best.y1],
      roi: [rx0, ry0, rx1, ry1],
      w,
      h,
    };
    return this.result;
  }

  /** Debug: paint the mask, the search region, and the blob box. */
  drawDebug(canvas, palette) {
    const r = this.result;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const m = this.mask;
    for (let p = 0; p < m.length && p < w * h; p++) {
      if (!m[p]) continue;
      const i = p * 4;
      if (m[p] === 2) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
      else { d[i] = palette.amber[0]; d[i + 1] = palette.amber[1]; d[i + 2] = palette.amber[2]; }
      d[i + 3] = 235;
    }
    ctx.putImageData(img, 0, 0);
    ctx.lineWidth = 1;
    if (r.roi) {
      ctx.strokeStyle = 'rgba(233,226,214,0.45)';
      ctx.strokeRect(r.roi[0] + 0.5, r.roi[1] + 0.5, r.roi[2] - r.roi[0] - 1, r.roi[3] - r.roi[1] - 1);
    }
    if (r.box) {
      ctx.strokeStyle = 'rgba(233,226,214,1)';
      ctx.strokeRect(r.box[0] - 1.5, r.box[1] - 1.5, r.box[2] - r.box[0] + 3, r.box[3] - r.box[1] + 3);
    }
  }
}
