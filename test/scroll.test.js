import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pngjs from 'pngjs';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { buildReport } from '../src/diff.js';
import { contentBottom, floatingTop, mayScroll, shiftBetween, stitch } from '../src/scroll.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';

const { PNG } = pngjs;
const el = (type, label, y, extra = {}) => ({ type, label, id: '', value: '', enabled: true, x: 0, y, w: 393, h: 44, ...extra });

test('scroll: shift measured on shared elements, the end of the content, bars left out', () => {
  const before = [el('Application', 'A', 0, { h: 852 }), el('Cell', 'Eins', 120), el('Cell', 'Zwei', 170), el('Cell', 'Drei', 800), el('Button', 'Start', 800, { tab: true })];
  const after = [el('Application', 'A', 0, { h: 852 }), el('Cell', 'Zwei', 30), el('Cell', 'Drei', 660), el('Cell', 'Vier', 710), el('Button', 'Start', 800, { tab: true })];
  assert.equal(shiftBetween(before, after), 140, 'median of Zwei and Drei; the tab does not count');
  assert.equal(shiftBetween(before, [el('Cell', 'Neu', 100)]), null);
  const size = { w: 393, h: 852 };
  assert.equal(contentBottom([el('Group', 'Tab-Leiste', 791, { bar: 'tab', h: 61 })], size), 791);
  assert.equal(contentBottom([], size), 818);
  assert.ok(mayScroll(before, size), 'Drei reaches the bottom');
  assert.ok(!mayScroll([el('Cell', 'Eins', 120)], size));
  assert.ok(mayScroll([el('Cell', 'Letzte', 770)], size), 'a row ending a few points above the bottom');
});

test('scroll: a search field floating over the bottom stays put while the list moves', () => {
  const size = { w: 402, h: 874 };
  const pill = el('SearchField', 'Suchen', 780, { h: 50 });
  const before = [el('Button', 'Bildschirmzeit', 762, { h: 52 }), el('Button', 'Kamera', 400, { h: 52 }), pill];
  const after = [el('Button', 'Bildschirmzeit', 412, { h: 52 }), el('Button', 'Kamera', 50, { h: 52 }), pill];
  assert.equal(floatingTop(before, after, size), 780);
  assert.equal(shiftBetween(before, after), 350, 'the field that did not move is no measure of the shift');
  assert.equal(floatingTop(before, before.map((e) => ({ ...e, y: e.y - 300 })), size), null);
});

test('scroll: pages joined into one tall picture: top of the first, what came up from below, the bottom bar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-'));
  // a 10 × 400 content of rows with their own value, seen through a 10 × 100 window (bar 90–100)
  const page = (offset, file) => {
    const p = new PNG({ width: 10, height: 100 });
    for (let y = 0; y < 100; y++) for (let x = 0; x < 10; x++) p.data.set(y >= 90 ? [0, 0, 255, 255] : [y + offset, 0, 0, 255], (y * 10 + x) * 4);
    fs.writeFileSync(path.join(dir, file), PNG.sync.write(p));
    return { file: path.join(dir, file), offset };
  };
  const pages = [page(0, 'a.png'), page(60, 'b.png'), page(110, 'c.png')];
  const r = stitch(pages, { scale: 1, bottom: 90, out: path.join(dir, 'all.png'), edge: 0 });
  assert.deepEqual(r, { width: 10, height: 210 });
  const all = PNG.sync.read(fs.readFileSync(path.join(dir, 'all.png')));
  const red = (y) => all.data[(y * 10) * 4];
  assert.deepEqual([red(0), red(89), red(90), red(149), red(150), red(199)], [0, 89, 90, 149, 150, 199], 'continuous content');
  assert.equal(all.data[(205 * 10) * 4 + 2], 255, 'the bottom bar once, at the end (from the first page)');
  // a limit cuts the content at the same length, however far the swipes went
  const cut = stitch(pages, { scale: 1, bottom: 90, out: path.join(dir, 'cut.png'), limit: 170, edge: 0 });
  assert.deepEqual(cut, { width: 10, height: 180 }, '170 rows of content and the bar');
  const c = PNG.sync.read(fs.readFileSync(path.join(dir, 'cut.png')));
  assert.equal(c.data[(169 * 10) * 4], 169);
  // the blurred edge above the bar (10 rows here) is skipped, except at the end of the list
  const e = stitch(pages, { scale: 1, bottom: 90, out: path.join(dir, 'edge.png'), edge: 10, ended: true });
  assert.deepEqual(e, { width: 10, height: 210 }, 'the same length: the end comes from the last page');
  const ep = PNG.sync.read(fs.readFileSync(path.join(dir, 'edge.png')));
  assert.deepEqual([0, 79, 80, 139, 140, 199].map((y) => ep.data[(y * 10) * 4]), [0, 79, 80, 139, 140, 199], 'still continuous');
  // a floating index at x 8–10 shows only on the first page
  const o = stitch(pages, { scale: 1, bottom: 90, out: path.join(dir, 'ov.png'), edge: 0, overlays: [{ x: 8, y: 0, w: 2, h: 90 }] });
  assert.ok(o);
});

const run = async (store, app, crawlOpts = {}) => {
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0, scroll: true, maxScrollPages: 5 }, crawlOpts);
  const logs = [];
  const atlas = await crawl({ driver: app, cfg, store, io: { log: (l, m) => logs.push(m), ask: async () => '' } });
  return { atlas, logs };
};

test('scroll: a long list is crawled page by page; a row only below the fold is tapped; one tall picture', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const app = new FakeApp({ long: 20 });
  const { atlas, logs } = await run(store, app);
  assert.equal(atlas.meta.status, 'done');
  const list = atlas.screens.find((s) => s.name === 'Alle Übungen');
  assert.ok(list.pages?.length >= 1, 'pages below the first');
  assert.ok(list.actions.some((a) => a.label === 'Übung R' && a.page >= 1), 'an action from a page below');
  assert.ok(list.texts.includes('Übung T'), 'texts of every page');
  assert.ok(atlas.screens.some((s) => s.name === 'Geheim'), 'the screen behind row 18 (R) was reached');
  assert.ok(logs.some((m) => /screen\.new s\d+ "Alle Übungen" .* \d+ pages, \d+ pt/.test(m)));
  const pic = PNG.sync.read(fs.readFileSync(path.join(store.runDir(atlas.meta.id), list.screenshot)));
  assert.equal(pic.height, 120 + 20 * 50 + 34, 'the whole list in one picture: title, 20 rows, bottom');

  // without scroll: row 18 (R) is never seen
  const flat = await run(new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure(), new FakeApp({ long: 20 }), { scroll: false });
  assert.ok(!flat.atlas.screens.some((s) => s.name === 'Geheim'));

  // the same again: everything found, nothing changed; a row more: the list changed, in words too
  store.setBaseline(atlas.meta.id);
  const again = await run(store, new FakeApp({ long: 20 }));
  const same = buildReport({ store, baseId: atlas.meta.id, headId: again.atlas.meta.id, cfg: structuredClone(DEFAULTS) });
  assert.deepEqual([same.summary.new, same.summary.changed, same.summary.bad], [0, 0, 1], 'only the crash of the fake app');
  const longer = await run(store, new FakeApp({ long: 21 }));
  const r = buildReport({ store, baseId: atlas.meta.id, headId: longer.atlas.meta.id, cfg: structuredClone(DEFAULTS) });
  const s = r.screens.find((x) => x.name === 'Alle Übungen');
  assert.equal(s.status, 'changed');
  assert.deepEqual(s.texts.added, ['Übung U']);
});
