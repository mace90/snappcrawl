import fs from 'node:fs';
import pngjs from 'pngjs';

const { PNG } = pngjs;

// Scrolling a long screen page by page (crawl.scroll): what moved, whether there is more, and
// one tall picture from the pages.

const BARS = /^(navigationbar|tabbar|toolbar)$/i;
const key = (e) => `${e.type}:${e.id || e.label}`;

// The parts of a screen that scroll: not the app itself, not bars and tabs.
export function contentOf(els) {
  const bars = els.filter((e) => e.bar || BARS.test(e.type));
  const inBar = (e) => bars.some((b) => b !== e && e.y + e.h / 2 >= b.y && e.y + e.h / 2 <= b.y + b.h && e.x + e.w / 2 >= b.x && e.x + e.w / 2 <= b.x + b.w);
  return els.filter((e) => !/^(application|window)$/i.test(e.type) && !e.tab && !e.bar && !BARS.test(e.type) && !inBar(e) && (e.label || e.id));
}

// Where the content ends at the bottom: the top of a tab bar or toolbar, else the screen's bottom
// minus the home indicator.
export function contentBottom(els, size) {
  const bottomBars = els.filter((e) => (e.bar === 'tab' || e.bar === 'tool' || /^(tabbar|toolbar)$/i.test(e.type)) && e.y > size.h / 2);
  return bottomBars.length ? Math.min(...bottomBars.map((b) => b.y)) : size.h - 34;
}

// More below? Content that reaches down to the bottom of the content area (within the height of
// about one row). A wrong guess costs one swipe after which nothing moved.
export function mayScroll(els, size) {
  const bottom = contentBottom(els, size);
  return contentOf(els).some((e) => e.y + e.h >= bottom - 60 && e.y < size.h * 1.5);
}

// The top of what floats over the bottom of the content (iOS 26 search bars, floating buttons):
// elements in the lower quarter that stay put while the content moves. null when nothing does.
export function floatingTop(before, after, size) {
  const at = new Map(after.map((e) => [key(e), e]));
  const fixed = contentOf(before).filter((e) => e.y > size.h * 0.75 && at.get(key(e)) && Math.abs(at.get(key(e)).y - e.y) < 1 && Math.abs(at.get(key(e)).h - e.h) < 1);
  return fixed.length ? Math.min(...fixed.map((e) => e.y)) : null;
}

// Elements that stay put while the content scrolls, other than bars (the A–Z section index of a
// list, a floating button): their frames, to keep them out of the lower pages of the tall picture.
export function fixedOverlays(before, after) {
  const at = new Map(contentOf(after).map((e) => [key(e), e]));
  return contentOf(before).filter((e) => {
    const n = at.get(key(e));
    return n && Math.abs(n.y - e.y) < 1 && Math.abs(n.x - e.x) < 1 && Math.abs(n.h - e.h) < 1;
  }).map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));
}

// How far the content moved up between two reads, in points: the median shift of the elements
// both reads have once each. null when nothing is in both (moved too far, or another screen).
export function shiftBetween(before, after) {
  const once = (els) => {
    const m = new Map();
    for (const e of contentOf(els)) m.set(key(e), m.has(key(e)) ? null : e);
    return m;
  };
  const a = once(before);
  const b = once(after);
  const d = [];
  let common = 0;
  // what did not move at all (a floating bar) says nothing about the content; when nothing moved,
  // the shift is 0 (the end), when nothing is in both, it is unknown
  for (const [k, e] of a) {
    if (!e || !b.get(k)) continue;
    common++;
    if (Math.abs(e.y - b.get(k).y) >= 1) d.push(e.y - b.get(k).y);
  }
  if (!common) return null;
  if (!d.length) return 0;
  d.sort((x, y) => x - y);
  return d[Math.floor(d.length / 2)];
}

// One tall picture from the pages of a screen. pages: [{ file, offset }] with offset the content
// shift from the first page in points; scale: pixels per point; bottom: where the content ends
// (points, above a tab bar or toolbar). The first page gives the top (with its bars), every
// further page adds what came up from below, the bottom bar comes from the first page too.
// limit: the content ends there (points from the top of the first page), cut off exactly, so two
// runs whose swipes went a little further or less far show the same length.
// overlays: frames (points) of what stays put on the screen; in the strips of the lower pages
// they are painted over with the row's colour just left of them.
// EDGE: iOS 26 blurs the content just above a bottom bar; new rows are taken above that.
export const EDGE = 48;
// ended + keepEnd: the list ended there (nothing moved any more): its last rows, in the edge,
// are added from the last page. Only without anything floating at the bottom: iOS 26 shrinks and
// grows a floating search field while scrolling, so that strip would differ from run to run.
export function stitch(pages, { scale, bottom, out, limit = Infinity, overlays = [], edge = EDGE, ended = false, keepEnd = true }) {
  const imgs = pages.map((p) => PNG.sync.read(fs.readFileSync(p.file)));
  const w = imgs[0].width;
  if (imgs.some((i) => i.width !== w || i.height !== imgs[0].height)) return false;
  const h = imgs[0].height;
  const bar = Math.min(h, Math.round(bottom * scale)); // first row of the bottom bar
  const cut = Math.max(Math.round(h / 2), bar - Math.round(edge * scale)); // first row of the blurred edge
  const strips = []; // [image, fromRow, toRow]
  const max = Number.isFinite(limit) ? Math.round(limit * scale) : Infinity; // content rows in all
  strips.push([imgs[0], 0, Math.min(cut, max)]);
  let rows = Math.min(cut, max);
  for (let i = 1; i < imgs.length && rows < max; i++) {
    const came = Math.round((pages[i].offset - pages[i - 1].offset) * scale); // rows that came up
    const add = Math.min(came, max - rows); // the upper part of them when the limit cuts
    if (add <= 0) continue;
    const from = Math.max(0, cut - came);
    strips.push([imgs[i], from, from + add]);
    rows += add;
  }
  if (ended && keepEnd && rows < max && cut < bar) {
    const add = Math.min(bar - cut, max - rows);
    strips.push([imgs.at(-1), cut, cut + add]);
    rows += add;
  }
  // the bottom bar from the first page: bars are translucent, and behind them is what the first
  // page shows in every run, not wherever the last swipe happened to stop
  strips.push([imgs[0], bar, h]);
  // what stays put shows once, on the first page: painted over in the strips of the others
  for (const r of overlays) {
    const x0 = Math.max(1, Math.floor(r.x * scale));
    const x1 = Math.min(w, Math.ceil((r.x + r.w) * scale));
    const y0 = Math.floor(r.y * scale);
    const y1 = Math.ceil((r.y + r.h) * scale);
    for (const st of strips) {
      if (st[0] === imgs[0]) continue;
      const [img, a, b] = st;
      for (let y = Math.max(a, y0); y < Math.min(b, y1); y++) {
        const left = (y * w + x0 - 1) * 4;
        for (let x = x0; x < x1; x++) img.data.copy(img.data, (y * w + x) * 4, left, left + 4);
      }
    }
  }
  const total = strips.reduce((n, [, a, b]) => n + (b - a), 0);
  const o = new PNG({ width: w, height: total });
  let y = 0;
  for (const [img, a, b] of strips) {
    img.data.copy(o.data, y * w * 4, a * w * 4, b * w * 4);
    y += b - a;
  }
  fs.writeFileSync(out, PNG.sync.write(o));
  return { width: w, height: total };
}
