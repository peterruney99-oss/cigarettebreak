# Match

A chat interface whose computation phase is a six minute burn that the user starts by lighting a real match. A class prototype on continuous play.

Static site. Vanilla HTML, CSS, ES modules. No build step. ml5.js from a CDN.

## File tree

```
.
├── index.html
├── css/
│   └── style.css
├── js/
│   ├── config.js        every tunable constant, the copy, the burnable
│   ├── main.js          state machine: chat, gate, ignition, burn, done
│   ├── timer.js         wall-clock burn clock, persisted in localStorage
│   ├── burnable.js      stage art or a single PNG, composed per frame
│   ├── view.js          layout, orientation, the light on the page
│   ├── flame.js         procedural flame, ember, smoke
│   ├── detector.js      fusion of glow and classifier, hysteresis, hold
│   ├── glow.js          amber glow detector
│   ├── classifier.js    ml5 image classifier (MobileNet or Teachable Machine)
│   └── util.js
├── assets/
│   ├── match/
│   │   ├── sheet.png          your original image
│   │   ├── stage-0.png        stage 1 with the flame removed (unlit)
│   │   ├── stage-1.png ... stage-5.png
│   │   └── reference-lit.png  stage 1 untouched, seeds the camera hue range
│   └── fonts/
│       ├── dm-mono-latin-400-normal.woff2
│       └── OFL-DM-Mono.txt
├── tools/
│   └── slice.py         re-slice a sheet into registered stages
├── vercel.json
├── README.md
├── TUNING.md
└── PRESENTATION_NOTES.md
```

## Run it locally

```
python3 -m http.server 8000
```

Open http://localhost:8000. The camera works on `localhost` without HTTPS. It does not work from a `file://` path.

## Deploy to Vercel

CLI:

```
npm i -g vercel
vercel            # first run: log in, accept the defaults, get a preview URL
vercel --prod     # promote to production
```

GitHub import:

1. Push this folder to a GitHub repository.
2. vercel.com/new, import the repository.
3. Framework Preset: Other. Build Command: empty. Output Directory: empty (the root).
4. Deploy. Every push to the main branch redeploys.

`vercel.json` sets `Permissions-Policy: camera=(self)`. Vercel serves HTTPS, which `getUserMedia` requires.

## Test affordances

None of these appear in the interface.

| | |
| --- | --- |
| `?speed=N` | time runs N times faster |
| `?t=SECONDS` | override the duration |
| `?demo=1` | no camera; the match catches by itself about 2.4 s after "Allow camera" |
| `?reset` | forget a stored burn (a reload otherwise resumes it) |
| key `L` | simulate ignition, from the gate or the ignition step |
| key `D` | detection debug overlay |

Rehearsal run in twenty seconds: `/?reset&t=20&demo=1`.

## Configuration

Everything is in `js/config.js`.

- `DURATION_SECONDS`: the wait. 360.
- `CONFIG.percentCountsUp`: false counts 100% down to 0%; true counts up.
- `CONFIG.orientation`: `'horizontal'` (head left, char advancing right) or `'vertical'`.
- `CONFIG.output.stubText`: the placeholder output.
- `CONFIG.detection.mode`: `'both'`, `'glow'`, or `'ml5'`.
- `CONFIG.detection.ml5.teachableMachineURL`: a custom model. See TUNING.md.

### Burning something else

Change one line: `export const BURNABLE = BURNABLES.match;`

- `BURNABLES.match`: the six pre-sliced stages.
- `BURNABLES.matchSheet`: the same sheet, sliced in the browser. Point `src` at any left-to-right stage sheet on a transparent background.
- `BURNABLES.single`: any one PNG, burned procedurally (noise dissolve, glowing edge). Point `src` at your image.

For final stage art, run the slicer instead of relying on browser slicing; it also cleans the matte fringe:

```
pip install pillow numpy
python3 tools/slice.py path/to/sheet.png assets/match
```

## How the match is drawn

The stage images are your pixels. Between two stages the char front is a moving, feathered mask; the part already burnt crossfades; and both stages are warped along the stick's centreline toward a shared in-between shape, so the final bend is animated instead of cut to. Only alpha is ever edited in the art: the flame is removed from stage 1, and the pale fringe left by background removal is turned down to 30% so it reads as a rim of light on a near-black page (`FRINGE_KEEP` in `tools/slice.py`).

The flame, ember, and smoke are drawn on canvas.

## Privacy

Camera frames are read into a canvas in the page and analysed there. Nothing is uploaded. No analytics. The only network requests besides the site's own files are the ml5 script (unpkg) and the model weights it downloads; neither carries video. `mode: 'glow'` makes no third-party request at all. The camera tracks are stopped the moment ignition is confirmed.

## Credits

DM Mono, SIL Open Font License (see `assets/fonts/OFL-DM-Mono.txt`). ml5.js, MIT.
