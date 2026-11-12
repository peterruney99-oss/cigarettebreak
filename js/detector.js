/*
 * detector.js
 * Fusion. Decides, once, that a match has been lit.
 *
 *   glow   the amber glow score, with hysteresis, must stay on for holdMs
 *   ml5    the classifier's target must stay above threshold for holdMs
 *          (only meaningful with a custom lit_match model; MobileNet's
 *          "matchstick" is true of unlit matches too)
 *   both   the glow must hold for holdMs AND the classifier must have agreed
 *          within its agreement window. One escape, on by default: a glow that
 *          holds unbroken for glowOverrideMs is accepted without the classifier,
 *          because a burning match will not wait for a model that calls it a candle.
 *
 * 'both' is the default. If ml5 or its model fails to load, the effective mode
 * drops to 'glow' and the page carries on.
 *
 * Throttling: the glow analysis runs about 15 times a second on a 128 pixel wide
 * frame; the classifier runs about 3 times a second, never overlapping itself.
 * Neither runs inside requestAnimationFrame, so rendering keeps its 60fps.
 */

import { GlowDetector } from './glow.js';
import { MatchClassifier } from './classifier.js';
import { clamp } from './util.js';

export class IgnitionDetector {
  constructor(cfg, palette) {
    this.cfg = cfg;
    this.palette = palette;
    this.requested = cfg.mode;
    this.glow = new GlowDetector(cfg.glow);
    this.classifier = cfg.mode === 'glow' ? null : new MatchClassifier(cfg.ml5, cfg.glow.roi);
    this.video = null;
    this.running = false;
    this.timer = 0;
    this.onIgnite = null;
    this.onUpdate = null;
    this.debugCanvas = null;
    this.debug = false;
    this.resetEvidence();
  }

  resetEvidence() {
    this.glowOn = false;
    this.glowSince = 0;
    this.glowLostAt = 0;
    this.mlOn = false;
    this.mlSince = 0;
    this.mlLostAt = 0;
    this.fused = 0;
    this.glow.reset();
  }

  /** Start downloads early (at the gate) so the classifier is warm by ignition. */
  preload() {
    this.glow.seed();
    if (this.classifier) this.classifier.load();
  }

  /** The mode actually in force right now. */
  get mode() {
    if (!this.classifier) return 'glow';
    if (this.classifier.state === 'failed') return 'glow';
    return this.requested;
  }

  start(video) {
    if (this.running) return;
    this.video = video;
    this.running = true;
    this.resetEvidence();
    if (this.classifier) this.classifier.start(video);
    const tick = () => {
      if (!this.running) return;
      this.step(performance.now());
      if (this.running) this.timer = setTimeout(tick, this.cfg.glow.intervalMs);
    };
    this.timer = setTimeout(tick, this.cfg.glow.intervalMs);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.classifier) this.classifier.stop();
    this.video = null;
  }

  /** Hold timer with a short grace period, so one dropped frame does not restart it. */
  hold(on, since, lostAt, now) {
    const { graceMs } = this.cfg;
    if (on) return { since: since || now, lostAt: 0 };
    if (!since) return { since: 0, lostAt: 0 };
    if (!lostAt) return { since, lostAt: now };
    if (now - lostAt > graceMs) return { since: 0, lostAt: 0 };
    return { since, lostAt };
  }

  step(now) {
    const cfg = this.cfg;
    const g = this.glow.process(this.video);

    // hysteresis on the glow score
    if (this.glowOn) { if (g.score < cfg.glow.offThreshold) this.glowOn = false; }
    else if (g.score >= cfg.glow.onThreshold) this.glowOn = true;
    let h = this.hold(this.glowOn, this.glowSince, this.glowLostAt, now);
    this.glowSince = h.since;
    this.glowLostAt = h.lostAt;
    const glowHold = this.glowSince ? clamp((now - this.glowSince) / cfg.holdMs) : 0;

    const c = this.classifier;
    const mode = this.mode;
    let mlHold = 0;
    let mlAgree = false;
    if (c && c.state === 'ready') {
      const thr = c.threshold;
      if (this.mlOn) { if (c.target < thr * 0.7) this.mlOn = false; }
      else if (c.target >= thr) this.mlOn = true;
      // classifier readings arrive slowly; allow two missed intervals of grace
      const fresh = now - c.updatedAt < cfg.ml5.intervalMs * 3 + 400;
      h = this.hold(this.mlOn && fresh, this.mlSince, this.mlLostAt, now);
      this.mlSince = h.since;
      this.mlLostAt = h.lostAt;
      mlHold = this.mlSince ? clamp((now - this.mlSince) / cfg.holdMs) : 0;
      mlAgree = c.agrees(now);
    }

    let confirmed = false;
    if (mode === 'glow') {
      this.fused = glowHold;
      confirmed = glowHold >= 1;
    } else if (mode === 'ml5') {
      this.fused = mlHold;
      confirmed = mlHold >= 1;
    } else {
      // both: the glow holds for holdMs and the classifier agrees. If the
      // classifier stays silent (still loading, or it calls the match a candle),
      // a much longer unbroken glow is accepted instead, when configured.
      const sustained = this.glowSince && cfg.glowOverrideMs > 0 ? (now - this.glowSince) / cfg.glowOverrideMs : 0;
      this.fused = mlAgree ? glowHold : Math.min(glowHold * 0.5, 0.5) + 0.5 * clamp(sustained) * (glowHold >= 1 ? 1 : 0);
      confirmed = glowHold >= 1 && (mlAgree || sustained >= 1);
    }

    if (this.debug && this.debugCanvas) this.glow.drawDebug(this.debugCanvas, this.palette);
    if (this.onUpdate) {
      this.onUpdate({
        mode,
        requested: this.requested,
        glow: g,
        glowOn: this.glowOn,
        glowHold,
        hue: [this.glow.hueMin, this.glow.hueMax],
        seeded: this.glow.seeded,
        ml: c
          ? { state: c.state, label: c.label, confidence: c.confidence, target: c.target, agree: mlAgree, hold: mlHold, custom: c.custom, error: c.error }
          : null,
        fused: this.fused,
      });
    }

    if (confirmed) {
      const cb = this.onIgnite;
      this.stop();
      if (cb) cb();
    }
  }
}
