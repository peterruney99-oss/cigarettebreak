/*
 * classifier.js
 * ml5.js image classification, used honestly.
 *
 * ml5 ships no "lit match" model. What it does ship is MobileNet trained on
 * ImageNet, and ImageNet happens to have a "matchstick" class. That class means
 * "this picture contains a match". It fires on an unlit match as readily as on a
 * burning one, so on its own it cannot confirm ignition. Here it is used for what
 * it can actually say: there is a match in front of the camera. Whether that
 * match is burning is the glow detector's job (see glow.js, detector.js).
 *
 * If you train a Teachable Machine image model with the classes
 * none / unlit_match / lit_match and set detection.ml5.teachableMachineURL,
 * that model replaces MobileNet and its lit_match class is trusted directly.
 *
 * API used, checked against the ml5 1.x reference (docs.ml5js.org) and the
 * 1.4.0 source:
 *   ml5.imageClassifier(modelNameOrUrl, ?options, ?callback) returns the
 *     classifier synchronously; classifier.ready is a promise for the loaded model.
 *   classifier.classify(media, ?kNumber, ?callback) returns a promise of
 *     [{ label, confidence }, ...] ordered by confidence.
 * classify() is called on our own schedule rather than classifyStart(), which
 * loops as fast as it can and would compete with rendering.
 *
 * Network note: ml5 itself and the model weights are downloaded. No video frame
 * is ever uploaded; inference runs in this tab.
 */

import { withTimeout, makeCanvas } from './util.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-ml5]`);
    if (existing && window.ml5) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.ml5 = '1';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('ml5 script failed to load'));
    document.head.appendChild(s);
  });
}

export class MatchClassifier {
  constructor(cfg, roi) {
    this.cfg = cfg;
    this.roi = roi;
    this.state = 'idle'; // idle | loading | ready | failed
    this.error = '';
    this.custom = Boolean(cfg.teachableMachineURL);
    this.classifier = null;
    this.input = makeCanvas(cfg.inputSize, cfg.inputSize);
    this.ictx = this.input.getContext('2d');
    this.running = false;
    this.timer = 0;
    // latest reading
    this.label = '';
    this.confidence = 0;
    this.target = 0;      // confidence that the thing we are looking for is present
    this.targetSeenAt = -Infinity;
    this.updatedAt = 0;
  }

  async load() {
    if (this.state !== 'idle') return this.state;
    this.state = 'loading';
    try {
      // One budget for script plus model, so a slow network cannot stall ignition.
      const classifier = await withTimeout(this.fetchModel(), this.cfg.loadTimeoutMs, 'ml5');
      this.classifier = classifier;
      this.state = 'ready';
    } catch (err) {
      this.error = String((err && err.message) || err);
      this.state = 'failed';
    }
    return this.state;
  }

  async fetchModel() {
    const cfg = this.cfg;
    await loadScript(cfg.src);
    if (!window.ml5 || typeof window.ml5.imageClassifier !== 'function') {
      throw new Error('ml5.imageClassifier is not available');
    }
    let url = cfg.teachableMachineURL;
    if (url && !/model\.json$/.test(url)) url = url.replace(/\/?$/, '/') + 'model.json';
    let classifier = this.custom
      ? window.ml5.imageClassifier(url)
      : window.ml5.imageClassifier('MobileNet', { topk: cfg.topk });
    // 1.x returns the instance and exposes .ready; tolerate a promise too.
    if (classifier && typeof classifier.then === 'function') classifier = await classifier;
    if (classifier && classifier.ready && typeof classifier.ready.then === 'function') await classifier.ready;
    return classifier;
  }

  /** Begin throttled, sequential inference on the video. */
  start(video) {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      const began = performance.now();
      if (this.state === 'ready' && video.videoWidth) {
        try {
          await this.inferOnce(video);
        } catch (err) {
          this.error = String((err && err.message) || err);
        }
      }
      if (!this.running) return;
      const spent = performance.now() - began;
      this.timer = setTimeout(tick, Math.max(40, this.cfg.intervalMs - spent));
    };
    tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  async inferOnce(video) {
    const cfg = this.cfg;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    // Classify the framing guide region only: the match, not the room.
    const sx = this.roi.x * vw, sy = this.roi.y * vh, sw = this.roi.w * vw, sh = this.roi.h * vh;
    this.ictx.drawImage(video, sx, sy, sw, sh, 0, 0, this.input.width, this.input.height);
    const results = await this.classifier.classify(this.input, this.custom ? undefined : cfg.topk);
    if (!Array.isArray(results) || !results.length) return;

    const now = performance.now();
    this.label = String(results[0].label);
    this.confidence = Number(results[0].confidence) || 0;
    let target = 0;
    if (this.custom) {
      for (const r of results) if (String(r.label) === cfg.tmLitLabel) target = Number(r.confidence) || 0;
      if (target >= cfg.tmThreshold) this.targetSeenAt = now;
    } else {
      for (const r of results) {
        const name = String(r.label).toLowerCase();
        if (cfg.labels.some((l) => name.includes(l.toLowerCase()))) target += Number(r.confidence) || 0;
      }
      if (target >= cfg.threshold) this.targetSeenAt = now;
    }
    this.target = target;
    this.updatedAt = now;
  }

  get threshold() {
    return this.custom ? this.cfg.tmThreshold : this.cfg.threshold;
  }

  /** True if the target was seen above threshold within the agreement window. */
  agrees(now = performance.now()) {
    return now - this.targetSeenAt <= this.cfg.agreeWindowMs;
  }
}
