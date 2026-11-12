# Tuning the flame detector

The detector has been exercised against synthetic camera feeds (a flickering flame, a still picture of a flame, a waving warm-lit hand, a face, an empty room). It has not seen a real match in your room. Budget ten minutes with a box of matches before presenting.

All constants are in `js/config.js` under `CONFIG.detection`.

## Read the overlay first

Start the flow, allow the camera, press **D**.

- Amber pixels are painted amber, core pixels white. The outer thin box is the search region (the framing guide). The bright box is the blob being judged.
- `glow score`: weakest of the tests below, scaled so 0.5 means "just passes". It switches ON at 0.5 and back off under 0.34.
- `hold`: fills to 1.00 over one second of unbroken ON. That is ignition (in `glow` mode, or in `both` once the classifier agrees).
- `blob`: `area`, `amber`, `core` in pixels, `contrast` (blob brightness minus surroundings, 0 to 1), `flicker` (frame-to-frame change, 0 to 1).
- `ml5`: top label and confidence, `target` (confidence summed over the labels you are watching for), `agree`.

Light a match and watch which number is the one holding the score down. Tune that one.

## It misses a real flame (typical in a bright classroom)

| What the overlay shows | Change |
| --- | --- |
| Flame is painted white with no amber around it | The halo is washed out. Lower `glow.satMin` 0.40 to 0.28, lower `glow.minAmber` 4 to 2 |
| Flame is amber but never white | The camera is not clipping. Lower `glow.coreValMin` 0.92 to 0.85. Last resort: `glow.requireCore: false` |
| Blob is found, `area` under 10 | Flame is small in frame. Hold it closer, lower `glow.minArea` to 6, or raise `glow.frameWidth` 128 to 192 |
| `contrast` under 0.10 | Flame is against a bright wall or window. Hold it in front of something dark (a sleeve works), or lower `glow.contrastMin` to 0.05 |
| `flicker` under 0.010 | Unusually steady flame or a slow camera. Lower `glow.flickerMin` to 0.006 |
| Score flickers ON and off, `hold` keeps resetting | Raise `graceMs` 180 to 350, lower `glow.offThreshold` 0.34 to 0.25 |
| Flame is orange-red or greenish-yellow and unpainted | Camera colour is off. Raise `glow.hueWiden` 8 to 16 |
| Glow is ON and held but nothing happens for four seconds | The classifier is not agreeing. See the next section |

## The classifier will not agree (`both` mode)

- `ml5 loading` for a long time: slow network. It gives up after `ml5.loadTimeoutMs` and the mode drops to `glow` by itself.
- Top label is `candle`, `torch`, `lighter`, `spotlight`: MobileNet sees fire, not a match. Add those to `ml5.labels`, or lower `ml5.threshold` 0.10 to 0.05.
- You do not need to wait for it: with `glowOverrideMs: 4000`, four unbroken seconds of glow ignites without the classifier. Lower it to 2500 if matches burn down too far. Set it to 0 only if you want a strict AND.
- For the day itself, `mode: 'glow'` is the dependable choice if the room's wifi is doubtful.

## It fires when nothing is lit

| Cause you can see in the overlay | Change |
| --- | --- |
| A lamp, window, or projector inside the guide | Narrow `glow.roi` (and the `.camera__guide` rectangle in `css/style.css` to match), or turn the laptop |
| Warm skin painted amber with a white highlight | Raise `glow.satMin` to 0.5 and `glow.minCoreFraction` 0.12 to 0.2 |
| An orange object or sleeve moving in frame | Raise `glow.flickerMin` to 0.02, raise `holdMs` 1000 to 1500 |
| A large warm region | Lower `glow.maxAreaFraction` 0.10 to 0.06 |
| Anything else | Set `glowOverrideMs: 0` so the classifier must agree, and narrow `glow.hueWiden` to 3 |

## Bright classroom, short version

1. Sit so the windows and the projector are outside the guide, ideally behind the camera.
2. Hold the match 20 to 30 cm from the lens, in front of dark clothing.
3. Start with `satMin 0.3`, `coreValMin 0.88`, `contrastMin 0.06`, `minArea 6`.
4. If the room has many warm lights, compensate with `flickerMin 0.015` and `maxAreaFraction 0.06`.

## A custom model

Train an image model at teachablemachine.withgoogle.com with three classes named exactly `none`, `unlit_match`, `lit_match`, in the room you will present in. Upload it, paste the share URL (ending in `/`) into `ml5.teachableMachineURL`. It replaces MobileNet. Its `lit_match` class is then trusted above `ml5.tmThreshold`, and `mode: 'ml5'` becomes meaningful.

## If everything fails on the day

Press **L**. It is not shown anywhere in the interface.
