/*
 * flame.js
 * The flame is the only thing on the page that is drawn rather than photographed.
 * Layered teardrops in the reference's amber, a pale core, flicker from smooth
 * noise, and a short smoke wisp when it dies. Canvas 2D only; no filters, so it
 * renders the same in Safari as in Chrome.
 */

import { noise1, rgba, clamp } from './util.js';

function teardrop(ctx, x, y, w, h, sway) {
  const b = w * 0.55; // the bulb wraps slightly below the base point
  ctx.beginPath();
  ctx.moveTo(x, y + b);
  ctx.bezierCurveTo(x + w * 1.3, y + b, x + w * 1.05, y - h * 0.42, x + sway, y - h);
  ctx.bezierCurveTo(x - w * 1.05, y - h * 0.42, x - w * 1.3, y + b, x, y + b);
  ctx.closePath();
}

/**
 * @param ctx        2D context, in CSS pixel space
 * @param x, y       base of the flame (the burn front)
 * @param height     nominal flame height in CSS pixels
 * @param t          seconds, drives flicker
 * @param intensity  0 (out) .. 1 (steady) .. >1 (flare)
 * @param still      true under prefers-reduced-motion: no flicker
 * @param bounds     {w, h} of the canvas, so the local glow never clips
 */
export function drawFlame(ctx, x, y, height, t, intensity, palette, cfg, still, bounds) {
  if (intensity <= 0.01) return;
  const n = still ? 0 : 1;
  const flick = 1 + n * (0.08 * noise1(t * 6.3, 1) + 0.045 * noise1(t * 14.1, 2));
  const h = height * intensity * flick;
  // width follows intensity too, so a dying flame stays a flame and not a bead
  const w = height * cfg.widthRatio * Math.pow(Math.min(1, intensity), 0.75) * (1 + n * 0.06 * noise1(t * 9.2, 3));
  const sway = n * w * (0.6 * noise1(t * 2.3, 4) + 0.3 * noise1(t * 7.7, 5));

  ctx.save();

  // Light close to the flame. The wide light on the page is a separate layer.
  const gy = y - h * 0.42;
  let r = height * 1.7;
  if (bounds) r = Math.max(8, Math.min(r, x, bounds.w - x, gy, bounds.h - gy));
  const glowA = clamp(0.2 * intensity * (1 + n * 0.12 * noise1(t * 5.1, 6)));
  const glow = ctx.createRadialGradient(x, gy, 0, x, gy, r);
  glow.addColorStop(0, rgba(palette.amber, glowA));
  glow.addColorStop(0.35, rgba(palette.amber, glowA * 0.38));
  glow.addColorStop(1, rgba(palette.amber, 0));
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = glow;
  ctx.fillRect(x - r, gy - r, r * 2, r * 2);

  // Halo: the soft outer envelope. Drawn as blur only, by pushing the shape
  // itself off-canvas and keeping its shadow.
  ctx.globalCompositeOperation = 'source-over';
  const OFF = 10000;
  ctx.shadowOffsetX = OFF * (ctx.getTransform().a || 1);
  ctx.shadowColor = rgba(palette.amber, 0.5);
  ctx.shadowBlur = w * 1.5 * (ctx.getTransform().a || 1);
  ctx.fillStyle = '#000';
  teardrop(ctx, x - OFF, y, w * 1.05, h * 1.02, sway);
  ctx.fill();
  ctx.shadowOffsetX = 0;

  // Body: deep amber at the base, amber through the middle, pale and thinning at the tip.
  const body = ctx.createLinearGradient(0, y + w * 0.55, 0, y - h);
  body.addColorStop(0, rgba(palette.amberDeep, 0.7));
  body.addColorStop(0.16, rgba(palette.amber, 0.86));
  body.addColorStop(0.5, rgba(palette.core, 0.84));
  body.addColorStop(0.86, rgba(palette.core, 0.5));
  body.addColorStop(1, rgba(palette.core, 0));
  ctx.shadowColor = rgba(palette.amber, 0.7);
  ctx.shadowBlur = w * 0.7 * (ctx.getTransform().a || 1);
  ctx.fillStyle = body;
  teardrop(ctx, x, y, w, h, sway);
  ctx.fill();

  // Core: the pale interior that the reference flame is mostly made of.
  const core = ctx.createLinearGradient(0, y + w * 0.3, 0, y - h * 0.7);
  core.addColorStop(0, rgba(palette.core, 0.5));
  core.addColorStop(0.35, rgba(palette.core, 0.9));
  core.addColorStop(1, rgba(palette.core, 0));
  ctx.shadowColor = rgba(palette.core, 0.9);
  ctx.shadowBlur = w * 0.9 * (ctx.getTransform().a || 1);
  ctx.fillStyle = core;
  teardrop(ctx, x, y - w * 0.25, w * 0.42, h * 0.68, sway * 0.55);
  ctx.fill();

  ctx.restore();
}

/** A small ember on the stick itself, where the char is being made. */
export function drawEmber(ctx, x, y, radius, t, alpha, palette, still) {
  if (alpha <= 0.01) return;
  const pulse = still ? 1 : 0.85 + 0.15 * noise1(t * 4.4, 7);
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, rgba(palette.amber, 0.7 * alpha * pulse));
  g.addColorStop(0.5, rgba(palette.amberDeep, 0.3 * alpha * pulse));
  g.addColorStop(1, rgba(palette.amberDeep, 0));
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

/**
 * Smoke wisp. `age` in seconds since the flame died, `life` its total duration.
 * One thin thread that rises, wanders, widens, and is gone.
 */
export function drawSmoke(ctx, x, y, height, age, life, palette) {
  if (age < 0 || age >= life) return;
  const u = age / life;
  const rise = height * 2.1 * (1 - Math.pow(1 - Math.min(1, u * 1.6), 2));
  const fade = Math.pow(1 - u, 1.6);
  const SEG = 26;
  ctx.save();
  ctx.lineCap = 'round';
  let px = x;
  let py = y;
  for (let i = 1; i <= SEG; i++) {
    const k = i / SEG;
    const yy = y - rise * k;
    const wander = height * 0.16 * Math.pow(k, 1.4);
    const xx = x + wander * (Math.sin(k * 5.2 + age * 1.7) + 0.5 * Math.sin(k * 11.0 - age * 2.3));
    ctx.strokeStyle = rgba(palette.smoke, 0.34 * fade * (1 - k) * Math.min(1, age * 3));
    ctx.lineWidth = 1.2 + k * height * 0.07 * (0.6 + u);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(xx, yy);
    ctx.stroke();
    px = xx;
    py = yy;
  }
  ctx.restore();
}
