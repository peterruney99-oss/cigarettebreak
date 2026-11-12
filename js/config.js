/*
 * config.js
 * Every number worth tuning lives here. Nothing in this file touches the DOM.
 */

/* The wait. One constant. */
export const DURATION_SECONDS = 360;

/*
 * BURNABLES
 * The thing that burns is one config entry. Three shapes are supported:
 *
 *   type: 'stages'  Pre-sliced, registered stage images (tools/slice.py output).
 *                   frames[0] is the unlit object, the last frame is the end state.
 *   type: 'sheet'   One PNG with the stages laid out left to right on a
 *                   transparent background. Sliced and registered in the browser.
 *                   Set firstHasFlame if stage 1 is drawn already lit.
 *   type: 'single'  Any one PNG. Burned procedurally: a noise dissolve with a
 *                   glowing edge at the front. No stage art needed.
 *
 * To burn something else, add an entry and point BURNABLE at it.
 */
export const BURNABLES = {
  match: {
    type: 'stages',
    frames: [
      'assets/match/stage-0.png',
      'assets/match/stage-1.png',
      'assets/match/stage-2.png',
      'assets/match/stage-3.png',
      'assets/match/stage-4.png',
      'assets/match/stage-5.png',
    ],
    // Char front of each frame as a 0..1 fraction of the object's length.
    // null = measure from the pixels (dark rows). Override if a custom sheet
    // measures badly, for example [0, 0.09, 0.25, 0.39, 0.66, 0.81].
    charFronts: null,
    // Within the final segment, the fraction at which the bend begins.
    bendStart: 0.2,
    flameScale: 1,
  },

  matchSheet: {
    type: 'sheet',
    src: 'assets/match/sheet.png',
    firstHasFlame: true,
    charFronts: null,
    bendStart: 0.2,
    flameScale: 1,
  },

  // Example of the procedural path. Point `src` at any transparent PNG.
  single: {
    type: 'single',
    src: 'assets/match/stage-0.png',
    // Direction of burn in the image's own space. 'y': top to bottom (upright
    // art; turned a quarter in the horizontal layout). 'x': left to right.
    // Leave it out and the burn simply follows CONFIG.orientation.
    axis: 'y',
    maxSize: 520,        // longest side, in pixels, of the working canvas
    noiseScale: 0.035,   // feature size of the dissolve noise (smaller = larger blotches)
    noiseAmount: 0.07,   // how ragged the front is, as a fraction of the length
    edgeWidth: 0.035,    // width of the glowing edge
    charWidth: 0.16,     // how far behind the edge the char lingers before it is gone
    flameScale: 1,
  },
};

export const BURNABLE = BURNABLES.match;

export const CONFIG = {
  duration: DURATION_SECONDS,

  // false: 100% counts down to 0% in lockstep with the clock.
  // true:  0% counts up to 100%.
  percentCountsUp: false,

  // 'horizontal': a bar, head at left, char advancing right.
  // 'vertical':   head at top, char advancing down.
  orientation: 'horizontal',

  burnable: BURNABLE,

  storageKey: 'match.ignition.v1',

  // How long the simulated strike takes in ?demo=1 before the match catches.
  demoIgniteDelayMs: 2400,

  // Screen reader announcements of remaining time.
  announceEveryMs: 10000,

  output: {
    stubText:
      'Output placeholder.\n\nThis panel stands in for whatever the computation returns. Replace CONFIG.output.stubText in js/config.js.',
  },

  /* Colour. All of it is sampled from the reference match. */
  palette: {
    amber: [242, 207, 80],      // most saturated flame pixels in the reference
    amberDeep: [232, 162, 58],  // the head, where flame meets phosphorus
    core: [251, 248, 231],      // the pale body of the flame
    smoke: [176, 170, 160],
  },

  flame: {
    // Flame height as a multiple of the stick's thickness. The reference flame
    // is about 2.8 head-widths tall.
    heightRatio: 4.6,
    widthRatio: 0.135,        // half-width as a fraction of height
    flare: 0.35,              // extra size at the moment of ignition
    flareDecay: 0.9,          // seconds
    dieFraction: 0.02,        // final share of the burn over which the flame shrinks
    smokeSeconds: 4.5,
    pageGlow: 0.15,           // strength of the light the flame throws on the page
  },

  detection: {
    /*
     * 'glow'  amber glow detector only
     * 'ml5'   classifier only (only meaningful with a custom lit_match model)
     * 'both'  glow must hold AND the classifier must agree
     * 'both' falls back to 'glow' on its own if ml5 or its model fails to load.
     */
    mode: 'both',

    holdMs: 1000,        // the evidence must be continuous for this long
    graceMs: 180,        // dropouts shorter than this do not reset the hold

    // 'both' only. A struck match gives you about fifteen seconds. If the glow
    // has held this long without a break and the classifier still has not
    // agreed, the glow is believed on its own. 0 makes 'both' a strict AND.
    glowOverrideMs: 4000,

    glow: {
      frameWidth: 128,   // analysis happens on a frame this wide
      intervalMs: 66,    // about 15 analyses per second

      // Region of the frame that is searched, as fractions. Matches the
      // framing guide. Keeps ceiling lights and windows out of the picture.
      roi: { x: 0.2, y: 0.12, w: 0.6, h: 0.76 },

      // Reference image used to seed the amber hue range at startup.
      seedImage: 'assets/match/reference-lit.png',
      // Fallback hue range in degrees if the seed image cannot be read
      // (5th to 95th percentile of saturated flame and head pixels in the reference).
      hueMin: 10,
      hueMax: 58,
      // Real cameras shift flame colour toward red (underexposed) or toward
      // yellow-white (overexposed). The seeded range is widened by this much.
      hueWiden: 8,

      satMin: 0.4,       // amber halo: minimum saturation
      valMin: 0.65,      // amber halo: minimum brightness
      coreValMin: 0.92,  // pale core: minimum brightness (near clipping)
      coreSatMax: 0.4,   // pale core: maximum saturation

      minArea: 10,       // pixels (at frameWidth) in the connected blob
      minAmber: 4,       // of which amber
      minCore: 2,        // of which pale core
      requireCore: true,
      minCoreFraction: 0.12, // share of the blob that must be core (skin with a highlight fails this)
      maxAreaFraction: 0.1,  // a blob filling this much of the ROI is a face or a wall, not a flame
      contrastMin: 0.1,  // blob mean luma minus surrounding mean luma (0..1). 0 disables.

      flickerMin: 0.01,  // mean frame-to-frame luma change inside the blob box (0..1)
      flickerSmoothing: 0.35,

      onThreshold: 0.5,  // hysteresis: score needed to switch on
      offThreshold: 0.34, // and the lower score that switches it back off
    },

    ml5: {
      src: 'https://unpkg.com/ml5@1/dist/ml5.min.js',
      loadTimeoutMs: 15000,
      intervalMs: 300,   // at most about 3 inferences per second
      inputSize: 224,

      // Default: pretrained MobileNet. ImageNet has a "matchstick" class.
      // Add 'candle' or 'torch' here if your lit match reads as one of those.
      labels: ['matchstick'],
      threshold: 0.1,
      topk: 8,
      // The classifier says "there is a match". It may have said so slightly
      // before the flame steadied, so agreement is remembered for this long.
      agreeWindowMs: 2500,

      // Custom Teachable Machine image model with classes
      // none / unlit_match / lit_match. Paste the share URL, ending in a slash:
      //   'https://teachablemachine.withgoogle.com/models/XXXXXXXX/'
      // When set, it replaces the MobileNet logic entirely.
      teachableMachineURL: '',
      tmLitLabel: 'lit_match',
      tmThreshold: 0.8,
    },
  },
};

export const COPY = {
  placeholder: 'Ask anything',
  placeholderLocked: 'Locked while it burns',
  send: 'Send',
  gateTitle: 'This computation requires a flame.',
  gateTerms: (duration) =>
    `The match burns for ${duration}. Once lit, it cannot be paused, cancelled, or skipped.`,
  gatePrivacy:
    'Allow the camera so it can see the match catch. Video is processed on this device. Nothing leaves the browser.',
  gateSafety:
    'Light the match over a non-flammable surface, away from the keyboard and screen, with water nearby.',
  gateButton: 'Allow camera',
  cameraStarting: 'Starting the camera.',
  ignitionCaption: 'Light a match.',
  cameraDenied:
    'Camera access was denied. Allow the camera for this page in the browser settings, then try again.',
  cameraMissing: 'No camera was found on this device.',
  cameraInsecure: 'The camera needs a secure connection. Open this page over https.',
  cameraFailed: 'The camera could not be started.',
  cameraDemoPointer: 'To run without a camera, add ?demo=1 to the address.',
  cameraRetry: 'Try again',
  lit: 'Lit.',
  done: 'Your results await you now.',
  viewOutput: 'view output',
  close: 'close',
};
