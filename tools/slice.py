#!/usr/bin/env python3
"""
Slice a left-to-right burn sheet into registered stage PNGs.

  python3 tools/slice.py path/to/sheet.png assets/match

What it does (and does not do):
  * Finds each object by scanning for fully transparent column gaps.
  * Registers every stage to a shared cell: common baseline, centred on the
    unburnt base of the stick, so stages overlay each other pixel for pixel.
  * Writes stage-0.png = stage 1 with its flame removed (the pre-ignition
    state), stage-1.png ... stage-5.png, and reference-lit.png (stage 1
    untouched, used to seed the camera's amber hue range).
  * Attenuates the pale matte fringe left by background removal. On a
    near-black page that fringe reads as a hard white outline; kept at a
    fraction it reads as a rim of light, which is the only thing that keeps
    black char legible on black. Set FRINGE_KEEP = 1 for a light page.
  * It never repaints pixels. Colour values are untouched; only alpha changes.

Requires: pillow, numpy.
"""
import sys, json
from pathlib import Path
import numpy as np
from PIL import Image

FRINGE_KEEP = 0.30      # 0 removes the pale fringe, 1 keeps it as delivered
PAD = 6                 # transparent padding around the shared cell
ALPHA_ON = 20           # alpha above this counts as "object" when slicing

def runs(mask):
    out, start = [], None
    for i, v in enumerate(mask):
        if v and start is None: start = i
        if not v and start is not None: out.append((start, i - 1)); start = None
    if start is not None: out.append((start, len(mask) - 1))
    return out

def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)

def attenuate_fringe(rgba):
    """Pale, low-chroma, semi-transparent edge pixels are matte fringe.
    Everything is a smooth function of alpha, luminance and chroma, so the
    edge stays as clean as the source instead of being nibbled by thresholds."""
    a = rgba.astype(np.float32)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    chroma = a[..., :3].max(-1) - a[..., :3].min(-1)
    pale = smoothstep(90, 170, lum) * (1 - smoothstep(30, 60, chroma))
    edge = 1 - smoothstep(140, 245, al)
    k = 1 - pale * edge * (1 - FRINGE_KEEP)
    out = rgba.copy(); out[..., 3] = np.clip(al * k, 0, 255).astype(np.uint8)
    return out

def remove_flame(cell):
    """Stage 1 minus flame: keep the stick column and the head disc only."""
    a = cell[..., 3] > 200
    h, w = a.shape
    widths = a.sum(1)
    # stick width = median opaque width over the lower half
    stick_w = np.median(widths[h // 2:][widths[h // 2:] > 0])
    rows = np.where(widths > 0)[0]
    # walk up from the middle: the head is where saturation jumps
    rgb = cell[..., :3].astype(np.float32)
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    row_sat = np.array([sat[y][a[y]].mean() if a[y].any() else 0 for y in range(h)])
    head_rows = [y for y in rows if row_sat[y] > 0.30 and y < h * 0.4]
    top, bot = min(head_rows), max(head_rows)
    cy, ry = (top + bot) / 2, (bot - top) / 2 + 1.5
    xs = np.where(a[int(cy)])[0]
    base = np.where(a[int(h * 0.8)])[0]
    cx = (base.min() + base.max()) / 2
    rx = max(stick_w / 2 + 2.5, ry * 0.98)
    yy, xx = np.mgrid[0:h, 0:w]
    disc = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1.0
    stick = (yy >= cy) & (np.abs(xx - cx) <= stick_w / 2 + 3)
    keep = disc | stick
    # soft edge on the disc so the head is not cut with a hard alias
    d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    soft = np.clip((1.06 - d) / 0.08, 0, 1)
    out = cell.copy()
    al = out[..., 3].astype(np.float32)
    al = np.where(stick, al, al * soft)
    al = np.where(keep | (soft > 0), al, 0)
    out[..., 3] = al.astype(np.uint8)
    return out, dict(head_top=int(top), head_bottom=int(bot))

def main(src, dst):
    dst = Path(dst); dst.mkdir(parents=True, exist_ok=True)
    im = np.array(Image.open(src).convert('RGBA'))
    on = im[..., 3] > ALPHA_ON
    cols = runs(on.any(0))
    assert len(cols) >= 2, 'expected several objects separated by transparent columns'
    boxes = []
    for x0, x1 in cols:
        ys = np.where(on[:, x0:x1 + 1].any(1))[0]
        boxes.append((x0, x1, ys.min(), ys.max()))
    bottom = max(b[3] for b in boxes)
    # registration: centre of the lowest 8% of each object (the unburnt base)
    centres = []
    for x0, x1, y0, y1 in boxes:
        band = on[int(y1 - (y1 - y0) * 0.08):y1 + 1, x0:x1 + 1]
        xs = np.where(band.any(0))[0]
        centres.append(x0 + (xs.min() + xs.max()) / 2)
    half = max(max(c - b[0], b[1] - c) for c, b in zip(centres, boxes))
    half = int(np.ceil(half)) + PAD
    top_all = min(b[2] for b in boxes[1:])          # ignore the flame of stage 1
    top_lit = boxes[0][2]
    def cell(i, top):
        c = int(round(centres[i]))
        y0 = top - PAD
        own = im.copy()
        x0, x1 = boxes[i][0], boxes[i][1]
        own[:, :x0, 3] = 0; own[:, x1 + 1:, 3] = 0   # never let a neighbour leak into this cell
        return own[y0:bottom + PAD + 1, c - half:c + half + 1].copy()
    meta = {}
    lit = cell(0, top_lit)
    Image.fromarray(lit).save(dst / 'reference-lit.png')
    s0, info = remove_flame(cell(0, top_all))
    Image.fromarray(attenuate_fringe(s0)).save(dst / 'stage-0.png')
    meta['stage-0'] = info
    for i in range(1, len(boxes)):
        Image.fromarray(attenuate_fringe(cell(i, top_all))).save(dst / f'stage-{i}.png')
    meta["cell"] = dict(w=int(2 * half + 1), h=int(bottom + PAD + 1 - (top_all - PAD)), stages=len(boxes))
    print(json.dumps(meta))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
