/*
 * main.js
 * The flow, as a small state machine:
 *
 *   chat  ->  gate  ->  ignition  ->  burn  ->  done  ->  (chat again)
 *              |  ^
 *              v  |
 *          camera-error
 *
 * There is deliberately no transition out of `burn` except time.
 *
 * Hidden test affordances (never shown in the interface):
 *   ?speed=N     multiply time
 *   ?t=SECONDS   override the duration
 *   ?demo=1      no camera; ignition is simulated
 *   ?reset       forget a stored burn
 *   key L        simulate ignition (gate and ignition states only)
 *   key D        toggle the detection debug overlay
 */

import { CONFIG, COPY } from './config.js';
import { createBurnClock } from './timer.js';
import { createBurnable } from './burnable.js';
import { BurnView } from './view.js';
import { IgnitionDetector } from './detector.js';
import { describeDuration, formatClock, smoothstep } from './util.js';

/* ------------------------------------------------------------------ */
/* Parameters                                                          */
/* ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const positive = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const SPEED = positive(params.get('speed'), 1);
const DURATION = positive(params.get('t'), CONFIG.duration);
const DEMO = params.get('demo') === '1';

if (params.has('reset')) {
  try { localStorage.removeItem(CONFIG.storageKey); } catch { /* nothing stored */ }
  params.delete('reset');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
}

/* ------------------------------------------------------------------ */
/* Elements and shared state                                           */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  thread: $('thread'),
  stage: $('stage'),
  camera: $('camera'),
  video: $('video'),
  debugCanvas: $('debugCanvas'),
  caption: $('caption'),
  burn: $('burn'),
  canvas: $('burnCanvas'),
  readout: $('readout'),
  percent: $('percent'),
  clock: $('clock'),
  composer: $('composer'),
  prompt: $('prompt'),
  send: $('send'),
  announcer: $('announcer'),
  glow: $('pageglow'),
  output: $('output'),
  outputText: $('outputText'),
  outputClose: $('outputClose'),
  debugPanel: $('debugPanel'),
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const clock = createBurnClock({ durationSeconds: DURATION, speed: SPEED, storageKey: CONFIG.storageKey });
const detector = new IgnitionDetector(CONFIG.detection, CONFIG.palette);

let state = 'boot';
let view = null;
let stream = null;
let gateEl = null;
let currentPrompt = '';
let rafId = 0;
let tickTimer = 0;
let doneTimer = 0;
let demoTimer = 0;
let ignitedPerf = -Infinity; // performance.now() of a live ignition; -Infinity when resumed
let diedPerf = -Infinity;
let lastAnnounce = 0;
let lastPercentText = '';
let lastClockText = '';
let debugOn = false;
let lastDetection = null;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

function setState(next) {
  state = next;
  el.app.dataset.state = next;
  const locked = next === 'gate' || next === 'camera-error' || next === 'ignition' || next === 'burn' || next === 'boot';
  el.prompt.disabled = locked;
  el.send.disabled = locked;
  el.prompt.placeholder = locked && next !== 'boot' ? COPY.placeholderLocked : COPY.placeholder;

  el.stage.hidden = next === 'chat' || next === 'boot';
  el.readout.hidden = !(next === 'burn' || next === 'done');
  el.caption.textContent = next === 'ignition' ? COPY.ignitionCaption : '';
  if (next === 'ignition') {
    el.camera.hidden = false;
    // next frame, so the expand transition runs
    requestAnimationFrame(() => el.camera.classList.add('is-open'));
  } else {
    el.camera.classList.remove('is-open');
    if (next !== 'burn') el.camera.hidden = true; // during burn it collapses first, see ignite()
  }
  renderDebug();
}

/* ------------------------------------------------------------------ */
/* Thread                                                              */
/* ------------------------------------------------------------------ */

function addMessage(role, build) {
  const msg = document.createElement('article');
  msg.className = `msg msg--${role}`;
  if (typeof build === 'string') {
    const p = document.createElement('p');
    p.textContent = build;
    msg.appendChild(p);
  } else {
    build(msg);
  }
  el.thread.appendChild(msg);
  el.thread.scrollTop = el.thread.scrollHeight;
  return msg;
}

function line(parent, text, className) {
  const p = document.createElement('p');
  p.textContent = text;
  if (className) p.className = className;
  parent.appendChild(p);
  return p;
}

function button(parent, text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = text;
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

function announce(text) {
  // Clearing first makes screen readers speak identical consecutive strings.
  el.announcer.textContent = '';
  requestAnimationFrame(() => { el.announcer.textContent = text; });
}

/* ------------------------------------------------------------------ */
/* 1. Chat                                                             */
/* ------------------------------------------------------------------ */

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state !== 'chat' && state !== 'done') return;
  const text = el.prompt.value.trim();
  if (!text) return;

  if (state === 'done') {
    // A new question is a new match.
    clock.clear();
    stopLoops();
    lastPercentText = '';
    lastClockText = '';
  }
  currentPrompt = text;
  el.prompt.value = '';
  addMessage('user', text);
  enterGate();
});

/* ------------------------------------------------------------------ */
/* 2. Gate                                                             */
/* ------------------------------------------------------------------ */

function enterGate() {
  setState('gate');
  gateEl = addMessage('system', (msg) => {
    line(msg, COPY.gateTitle);
    const detail = document.createElement('div');
    detail.className = 'msg__detail';
    if (COPY.gateTerms) line(detail, COPY.gateTerms(describeDuration(DURATION / SPEED)));
    line(detail, COPY.gatePrivacy);
    line(detail, COPY.gateSafety, 'msg__safety');
    const status = line(detail, '', 'msg__status');
    status.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'msg__actions';
    button(actions, COPY.gateButton, requestCamera);
    detail.appendChild(actions);
    msg.appendChild(detail);
  });
  el.burn.setAttribute('aria-valuenow', '0');
  el.burn.removeAttribute('aria-valuetext');
  showStage();
  renderStatic();
  if (!DEMO) detector.preload();
  const b = gateEl.querySelector('button');
  if (b) b.focus({ preventScroll: true });
}

function gateStatus(text, { pointer = false, retry = false } = {}) {
  if (!gateEl) return;
  const status = gateEl.querySelector('.msg__status');
  const actions = gateEl.querySelector('.msg__actions');
  if (!status || !actions) return;
  status.hidden = !text;
  status.textContent = text + (pointer ? ` ${COPY.cameraDemoPointer}` : '');
  actions.textContent = '';
  if (retry) button(actions, COPY.cameraRetry, requestCamera).focus({ preventScroll: true });
}

/** At the moment of striking, only the safety line still matters. */
function trimGate() {
  if (!gateEl) return;
  for (const node of gateEl.querySelectorAll('.msg__detail > :not(.msg__safety):not(.msg__status):not(.msg__actions)')) {
    node.remove();
  }
  gateStatus('');
}

async function requestCamera() {
  if (state !== 'gate' && state !== 'camera-error') return;

  if (DEMO) {
    // No camera at all. Show the ignition step, then let the match catch.
    trimGate();
    setState('ignition');
    announce(COPY.ignitionCaption);
    demoTimer = setTimeout(() => ignite(), CONFIG.demoIgniteDelayMs);
    return;
  }

  if (!window.isSecureContext) return cameraError(COPY.cameraInsecure);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return cameraError(COPY.cameraMissing);

  setState('gate');
  gateStatus(COPY.cameraStarting);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return cameraError(COPY.cameraDenied);
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
      return cameraError(COPY.cameraMissing);
    }
    return cameraError(COPY.cameraFailed);
  }
  // The user may have pressed L (or the page moved on) while the prompt was open.
  if (state !== 'gate') return releaseCamera();

  // If the camera is unplugged or taken by another app mid-wait, say so.
  const [track] = stream.getVideoTracks();
  if (track) {
    track.addEventListener('ended', () => {
      if (state === 'ignition') cameraError(COPY.cameraFailed);
    });
  }

  el.video.srcObject = stream;
  try { await el.video.play(); } catch { /* autoplay with muted + playsinline is allowed; ignore */ }
  if (state !== 'gate') return releaseCamera();
  // Shape the preview like the camera, so the guide and the debug mask line up with the picture.
  if (el.video.videoWidth && el.video.videoHeight) {
    el.video.parentElement.style.aspectRatio = `${el.video.videoWidth} / ${el.video.videoHeight}`;
  }

  trimGate();
  setState('ignition');
  announce(COPY.ignitionCaption);
  detector.debugCanvas = el.debugCanvas;
  detector.onUpdate = (d) => { lastDetection = d; renderDebug(); };
  detector.onIgnite = () => ignite();
  detector.start(el.video);
}

function cameraError(text) {
  releaseCamera();
  setState('camera-error');
  gateStatus(text, { pointer: true, retry: true });
}

/** Stop every track so the browser's camera indicator goes off. */
function releaseCamera() {
  detector.stop();
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  el.video.pause();
  el.video.srcObject = null;
  el.video.removeAttribute('src');
}

/* ------------------------------------------------------------------ */
/* 3 and 4. Ignition, then the burn                                    */
/* ------------------------------------------------------------------ */

function ignite() {
  if (state !== 'gate' && state !== 'camera-error' && state !== 'ignition') return;
  clearTimeout(demoTimer);
  releaseCamera();

  clock.ignite(currentPrompt);
  ignitedPerf = performance.now();
  collapseGate();

  // Let the preview fold away, then remove it from the layout and the tab order.
  const cam = el.camera;
  setState('burn');
  const hide = () => { if (state === 'burn' || state === 'done') cam.hidden = true; };
  if (reducedMotion.matches || cam.hidden) hide();
  else setTimeout(hide, 950);

  announce(`${COPY.lit} ${describeDuration(clock.realMsUntilDone() / 1000)} remaining.`);
  startBurn();
}

function collapseGate() {
  if (!gateEl) return;
  const detail = gateEl.querySelector('.msg__detail');
  if (detail) detail.remove();
  gateEl = null;
}

function startBurn() {
  stopLoops();
  lastAnnounce = performance.now();
  // If the tab is in the background, requestAnimationFrame sleeps. This timeout
  // still fires, so the result is posted on time.
  doneTimer = setTimeout(checkDone, clock.realMsUntilDone() + 60);
  frame();
}

function stopLoops() {
  cancelAnimationFrame(rafId);
  clearTimeout(tickTimer);
  clearTimeout(doneTimer);
}

function checkDone() {
  if (state !== 'burn') return;
  if (clock.remainingMs() <= 0) finish(true);
  else doneTimer = setTimeout(checkDone, clock.realMsUntilDone() + 60);
}

function flameIntensity(progress) {
  const age = (performance.now() - ignitedPerf) / 1000;
  const f = CONFIG.flame;
  // catch, flare, settle
  const rise = Number.isFinite(age) ? 1 - Math.exp(-age / 0.12) : 1;
  const flare = Number.isFinite(age) ? 1 + f.flare * Math.exp(-age / f.flareDecay) : 1;
  // and at the very end, shrink to nothing
  const die = smoothstep(1, 1 - f.dieFraction, progress);
  return rise * flare * die;
}

function frame() {
  if (state !== 'burn') return;
  const now = Date.now();
  const remaining = clock.remainingMs(now);
  const progress = 1 - remaining / clock.durationMs;
  updateReadout(remaining);

  const still = reducedMotion.matches;
  if (view) {
    view.render({
      progress,
      t: still ? 0 : performance.now() / 1000,
      intensity: flameIntensity(progress),
      ember: 1,
      smokeAge: -1,
      still,
    });
  }
  if (debugOn) renderDebug();
  if (remaining <= 0) return finish(true);

  // Reduced motion: the match still advances, but in quiet steps, without flicker.
  if (still) tickTimer = setTimeout(frame, 500);
  else rafId = requestAnimationFrame(frame);
}

function updateReadout(remaining) {
  const leftPct = Math.ceil((remaining / clock.durationMs) * 100);
  const shown = CONFIG.percentCountsUp ? 100 - leftPct : leftPct;
  const pText = `${shown}%`;
  const cText = formatClock(remaining / SPEED);
  if (pText !== lastPercentText) { el.percent.textContent = pText; lastPercentText = pText; }
  if (cText !== lastClockText) { el.clock.textContent = cText; lastClockText = cText; }

  const perf = performance.now();
  if (perf - lastAnnounce >= CONFIG.announceEveryMs || remaining <= 0) {
    lastAnnounce = perf;
    const text = `${leftPct} percent remaining. ${describeDuration(remaining / SPEED / 1000)}.`;
    el.burn.setAttribute('aria-valuenow', String(100 - leftPct));
    el.burn.setAttribute('aria-valuetext', remaining > 0 ? text : 'Complete.');
    if (remaining > 0) announce(text);
  }
}

/* ------------------------------------------------------------------ */
/* 5. Output                                                           */
/* ------------------------------------------------------------------ */

function finish(animated) {
  if (state === 'done') return;
  stopLoops();
  setState('done');
  el.camera.hidden = true;
  updateReadout(0);
  el.burn.setAttribute('aria-valuenow', '100');
  el.burn.setAttribute('aria-valuetext', 'Complete.');

  addMessage('system', (msg) => {
    line(msg, COPY.done);
    const actions = document.createElement('div');
    actions.className = 'msg__actions';
    button(actions, COPY.viewOutput, openOutput);
    msg.appendChild(actions);
  });

  if (animated && !reducedMotion.matches && view) {
    diedPerf = performance.now();
    afterglow();
  } else {
    renderStatic();
  }
}

/** The flame is out. A wisp of smoke, an ember that cools, then stillness. */
function afterglow() {
  if (state !== 'done' || !view) return;
  const age = (performance.now() - diedPerf) / 1000;
  const life = CONFIG.flame.smokeSeconds;
  view.render({
    progress: 1,
    t: performance.now() / 1000,
    intensity: 0,
    ember: Math.max(0, 1 - age / 1.6),
    smokeAge: age,
    still: false,
  });
  if (age < life) rafId = requestAnimationFrame(afterglow);
  else renderStatic();
}

function openOutput() {
  el.outputText.textContent = CONFIG.output.stubText;
  if (typeof el.output.showModal === 'function') el.output.showModal();
  else el.output.setAttribute('open', '');
}
el.outputClose.addEventListener('click', () => {
  if (typeof el.output.close === 'function') el.output.close();
  else el.output.removeAttribute('open');
});

/* ------------------------------------------------------------------ */
/* Rendering outside the burn loop                                     */
/* ------------------------------------------------------------------ */

function showStage() {
  el.stage.hidden = false;
  if (view) view.resize();
}

function renderStatic() {
  if (!view || state === 'burn') return;
  view.render({
    progress: state === 'done' ? 1 : 0,
    t: 0,
    intensity: 0,
    ember: 0,
    smokeAge: -1,
    still: true,
  });
}

if ('ResizeObserver' in window) {
  new ResizeObserver(() => {
    if (!view || el.stage.hidden) return;
    view.resize();
    if (state !== 'burn') renderStatic();
  }).observe(el.canvas);
} else {
  window.addEventListener('resize', () => {
    if (!view || el.stage.hidden) return;
    view.resize();
    renderStatic();
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state === 'burn') {
    // Coming back from the background: redraw from the wall clock immediately.
    cancelAnimationFrame(rafId);
    clearTimeout(tickTimer);
    frame();
  }
});

/* ------------------------------------------------------------------ */
/* Hidden keys and the debug overlay                                   */
/* ------------------------------------------------------------------ */

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const key = e.key.toLowerCase();
  if (key === 'd') {
    debugOn = !debugOn;
    detector.debug = debugOn;
    el.app.toggleAttribute('data-debug', debugOn);
    el.debugCanvas.hidden = !debugOn;
    el.debugPanel.hidden = !debugOn;
    renderDebug();
  } else if (key === 'l') {
    ignite();
  }
});

function renderDebug() {
  if (!debugOn) return;
  const d = lastDetection;
  const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '-');
  const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : '-');
  const rows = [];
  rows.push(`state     ${state}${DEMO ? '  (demo)' : ''}`);
  rows.push(`clock     ${formatClock(clock.remainingMs() / SPEED)}  p ${f3(clock.progress())}  speed ${SPEED}  duration ${DURATION}s`);
  if (d && state === 'ignition') {
    rows.push(`mode      ${d.mode}${d.mode !== d.requested ? `  (asked for ${d.requested}, fell back)` : ''}`);
    rows.push(`hue       ${d.hue[0].toFixed(0)}..${d.hue[1].toFixed(0)} deg${d.seeded ? '  seeded from reference' : '  config fallback'}`);
    rows.push(`glow      score ${f2(d.glow.score)}  ${d.glowOn ? 'ON ' : 'off'}  hold ${f2(d.glowHold)}`);
    rows.push(`blob      area ${d.glow.area}  amber ${d.glow.amber}  core ${d.glow.core}  contrast ${f2(d.glow.contrast)}  flicker ${f3(d.glow.flicker)}`);
    if (d.ml) {
      const what = d.ml.state === 'ready' ? `${d.ml.label || '-'} ${f2(d.ml.confidence)}` : d.ml.state;
      rows.push(`ml5       ${what}`);
      rows.push(`          target ${f2(d.ml.target)}  agree ${d.ml.agree ? 'yes' : 'no'}  hold ${f2(d.ml.hold)}${d.ml.custom ? '  custom model' : ''}`);
      if (d.ml.error) rows.push(`          ${d.ml.error}`);
    } else {
      rows.push('ml5       not used');
    }
    rows.push(`fused     ${f2(d.fused)}`);
  } else {
    rows.push(`detector  idle (mode ${detector.mode})`);
  }
  rows.push('keys      D overlay   L simulate ignition');
  el.debugPanel.textContent = rows.join('\n');
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  el.prompt.placeholder = COPY.placeholder;
  el.send.textContent = COPY.send;
  el.outputClose.textContent = COPY.close;
  el.app.dataset.orientation = CONFIG.orientation;

  try {
    const burnable = await createBurnable(CONFIG.burnable, CONFIG.orientation);
    // The canvas needs a size before the view can lay itself out.
    el.stage.hidden = false;
    view = new BurnView({
      canvas: el.canvas,
      glowEl: el.glow,
      burnable,
      orientation: CONFIG.orientation,
      palette: CONFIG.palette,
      flameCfg: CONFIG.flame,
    });
    el.stage.hidden = true;
  } catch (err) {
    // Without art there is still a clock; the wait is the point.
    console.error(err);
  }

  if (clock.restore()) {
    // A match was lit before this page load. It has been burning ever since.
    currentPrompt = clock.prompt;
    if (currentPrompt) addMessage('user', currentPrompt);
    addMessage('system', COPY.gateTitle);
    showStage();
    if (clock.remainingMs() > 0) {
      ignitedPerf = -Infinity;
      setState('burn');
      el.camera.hidden = true;
      startBurn();
    } else {
      finish(false);
    }
    return;
  }

  setState('chat');
  el.prompt.focus({ preventScroll: true });
}

boot();
