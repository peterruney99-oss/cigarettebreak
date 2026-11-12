/*
 * view.js
 * Puts the burnable and its flame on screen. Owns layout (orientation, scale,
 * where the flame has room to stand) and the one light the page has: a wide,
 * faint pool of amber that follows the flame.
 */

import { drawFlame, drawEmber, drawSmoke } from './flame.js';
import { clamp } from './util.js';

export class BurnView {
  constructor({ canvas, glowEl, burnable, orientation, palette, flameCfg }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.glowEl = glowEl;
    this.burnable = burnable;
    this.orientation = orientation;
    this.palette = palette;
    this.flameCfg = flameCfg;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.k = 1;
    this.ox = 0;
    this.oy = 0;
    this.rotate = orientation === 'horizontal' && burnable.nativeAxis === 'y';
    this.glowX = null;
    this.glowY = null;
    // At rest the front sits on the object's centreline. Remember it now: later
    // the front wanders (the curl), and layout must not follow it.
    this.spine = burnable.front().x;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    this.layout();
  }

  layout() {
    const b = this.burnable;
    const { w, h } = this;
    const fc = this.flameCfg;
    const flameFactor = b.thickness * fc.heightRatio * b.flameScale * (1 + fc.flare);

    if (this.orientation === 'horizontal') {
      const length = this.rotate ? b.height : b.width;
      const across = this.rotate ? b.width : b.height;
      const centreY = h * 0.62;
      // long enough to read as a bar, short enough that the flame fits above it
      let k = Math.min(w * 0.86, 600) / length;
      k = Math.min(k, (centreY - 10) / flameFactor);
      if (!this.rotate) k = Math.min(k, (h * 0.5) / across);
      this.k = k;
      this.ox = (w - length * k) / 2;
      if (this.rotate) {
        this.oy = centreY - (b.width - this.spine) * k;
      } else {
        this.oy = centreY - (across * k) / 2;
      }
    } else {
      const headroom = h * 0.3;
      let k = Math.min((h * 0.66) / b.height, (w * 0.8) / b.width);
      k = Math.min(k, (headroom - 10) / flameFactor);
      this.k = k;
      this.ox = (w - b.width * k) / 2;
      this.oy = headroom;
    }
  }

  /** Source pixel to CSS pixel inside the canvas. */
  toScreen(pt) {
    if (this.rotate) {
      return { x: this.ox + pt.y * this.k, y: this.oy + (this.burnable.width - pt.x) * this.k };
    }
    return { x: this.ox + pt.x * this.k, y: this.oy + pt.y * this.k };
  }

  /**
   * @param s.progress   0..1
   * @param s.t          seconds, for flicker
   * @param s.intensity  flame intensity, 0 when unlit or out
   * @param s.ember      0..1
   * @param s.smokeAge   seconds since the flame died, or -1
   * @param s.still      prefers-reduced-motion
   */
  render(s) {
    const { ctx, burnable: b, k, dpr } = this;
    b.update(s.progress, s.t);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (this.rotate) {
      // quarter turn, head to the left: (x, y) -> (ox + y k, oy + (W - x) k)
      ctx.transform(0, -k, k, 0, this.ox, this.oy + b.width * k);
    } else {
      ctx.transform(k, 0, 0, k, this.ox, this.oy);
    }
    ctx.drawImage(b.canvas, 0, 0);
    ctx.restore();

    const front = this.toScreen(b.front());
    const thick = b.thickness * k;
    const flameH = thick * this.flameCfg.heightRatio * b.flameScale;
    const baseY = front.y - thick * 0.3;

    drawEmber(ctx, front.x, front.y, thick * 1.1, s.t, s.ember, this.palette, s.still);
    drawFlame(ctx, front.x, baseY, flameH, s.t, s.intensity, this.palette, this.flameCfg, s.still, { w: this.w, h: this.h });
    if (s.smokeAge >= 0) {
      drawSmoke(ctx, front.x, baseY, flameH, s.smokeAge, this.flameCfg.smokeSeconds, this.palette);
    }

    this.updatePageGlow(front.x, baseY - flameH * 0.4, s);
  }

  updatePageGlow(x, y, s) {
    const el = this.glowEl;
    if (!el) return;
    const strength = clamp(s.intensity) * this.flameCfg.pageGlow;
    if (strength <= 0.002) {
      if (el.style.opacity !== '0') el.style.opacity = '0';
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const gx = rect.left + x;
    const gy = rect.top + y;
    // Position only when it has really moved; opacity is cheap to change every frame.
    if (this.glowX === null || Math.abs(gx - this.glowX) > 0.5 || Math.abs(gy - this.glowY) > 0.5) {
      this.glowX = gx;
      this.glowY = gy;
      el.style.setProperty('--fx', `${gx.toFixed(1)}px`);
      el.style.setProperty('--fy', `${gy.toFixed(1)}px`);
    }
    const breathe = s.still ? 1 : 1 + 0.1 * Math.sin(s.t * 7.3) * Math.sin(s.t * 3.1);
    el.style.opacity = (strength * breathe).toFixed(3);
  }
}
