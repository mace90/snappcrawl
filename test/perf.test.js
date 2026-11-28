import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { crawl } from '../src/crawler.js';
import { Store } from '../src/store.js';
import { FakeApp } from './fake-app.js';
import { TabApp } from './fake-tabs.js';

// Count what a crawl costs on the device: launches, reads of the screen, app state queries.
const measure = async (app, bundleId) => {
  const n = { launches: 0, reads: 0, states: 0 };
  const wrap = (k, key) => {
    const f = app[k].bind(app);
    app[k] = async (...a) => (n[key]++, f(...a));
  };
  wrap('launch', 'launches');
  wrap('elements', 'reads');
  wrap('isRunning', 'states');
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = bundleId;
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 });
  const logs = [];
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const atlas = await crawl({ driver: app, cfg, store, io: { log: (l, m) => logs.push(m), ask: async () => '' } });
  return { atlas, logs, n };
};

test('perf: a screen on the way is reached without restarting the app', async () => {
  const { atlas, logs, n } = await measure(new TabApp(), 'com.tabs.app');
  assert.equal(atlas.meta.status, 'done');
  assert.ok(logs.some((m) => /replay s\d+ ok · from s\d+ without a restart/.test(m)));
  assert.ok(n.launches <= 6, `${n.launches} launches (11 before)`);
  assert.ok(n.reads <= 175, `${n.reads} reads (205 before)`);
});

test('perf: the app state is asked only when the screen is not the app’s own', async () => {
  const { atlas, n } = await measure(new FakeApp(), 'com.pulse.app');
  const taps = atlas.edges.length;
  assert.ok(atlas.screens.some((s) => s.crash), 'the crash is still found');
  assert.ok(n.states <= 2, `${n.states} app state queries for ${taps} transitions`);
});

test('relaunch: an app that reopens where it was left is taken back, its screens are not one-time', async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const cfgFor = (app) => {
    const cfg = structuredClone(DEFAULTS);
    cfg.app.bundleId = 'com.pulse.app';
    Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
    Object.assign(cfg.crawl, { settleMs: 0, launchMs: 0 });
    return cfg;
  };
  const first = new FakeApp();
  store.setBaseline((await crawl({ driver: first, cfg: cfgFor(first), store, io: { log() {}, ask: async () => '' } })).meta.id);
  // the first tap on "Profil" shows another profile: tried once more after a fresh start, which
  // reopens the app on that profile, like iOS Settings reopens on the page it was left on
  const app = new FakeApp({ restore: true, flaky: 1 });
  const logs = [];
  const atlas = await crawl({ driver: app, cfg: cfgFor(app), store, io: { log: (l, m) => logs.push(m), ask: async () => '' } });
  assert.equal(atlas.meta.status, 'done');
  assert.ok(app.reopened > 0, 'the app reopened on a deeper screen');
  assert.ok(logs.some((m) => /opened on (s\d+ )?".+" · it remembers where it was · going back/.test(m)), logs.join('\n'));
  assert.ok(!logs.some((m) => /launch screen is now/.test(m)));
  assert.ok(atlas.screens.every((s) => !s.oneTime));
});

test('launch: the home screen that shows for a moment after a launch is not taken for the app', async () => {
  const app = new FakeApp();
  const launch = app.launch.bind(app);
  const elements = app.elements.bind(app);
  let slow = 0;
  app.launch = async () => ((slow = 2), launch()); // the next 2 reads still show the home screen
  app.elements = async () => (slow-- > 0 ? [{ type: 'Application', label: '', x: 0, y: 0, w: 393, h: 852, enabled: true, value: '', id: '' }, { type: 'Button', label: 'Fitness', x: 20, y: 100, w: 60, h: 60, enabled: true, value: '', id: '' }] : elements());
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 1 });
  const logs = [];
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const atlas = await crawl({ driver: app, cfg, store, io: { log: (l, m) => logs.push(m), ask: async () => '' } });
  assert.equal(atlas.meta.status, 'done');
  assert.ok(logs.some((m) => /waiting for .* to come to the front \(home screen still showing\)/.test(m)), logs.slice(0, 6).join('\n'));
  assert.ok(!atlas.screens.some((s) => s.name === 'Fitness'), 'the home screen is not a screen of the app');
  assert.equal(atlas.screens.filter((s) => s.crash).length, 1, 'only the real crash');
});

test('launch: an app that never comes to the front stops the crawl with a clear error', async () => {
  const app = new FakeApp();
  app.elements = async () => [{ type: 'Application', label: '', x: 0, y: 0, w: 393, h: 852, enabled: true, value: '', id: '' }];
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 1 });
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const t0 = Date.now();
  const atlas = await crawl({ driver: app, cfg, store, io: { log() {}, ask: async () => '' } });
  assert.equal(atlas.meta.status, 'failed');
  assert.match(atlas.meta.error, /did not come to the front within 15 s after the launch \(the home screen is showing\)/);
  assert.ok(Date.now() - t0 < 20_000);
});

test('launch: the app already in front before the start is the app, not something to wait for', async () => {
  const app = new FakeApp();
  app.running = true; // in front before the crawl starts
  app.stack = ['splash'];
  const cfg = structuredClone(DEFAULTS);
  cfg.app.bundleId = 'com.pulse.app';
  Object.assign(cfg.auth, { username: app.user, password: app.pass, mfa: 'totp', totpSecret: app.secret });
  Object.assign(cfg.crawl, { settleMs: 0, launchMs: 1 });
  const logs = [];
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'snappcrawl-'))).ensure();
  const t0 = Date.now();
  const atlas = await crawl({ driver: app, cfg, store, io: { log: (l, m) => logs.push(m), ask: async () => '' } });
  assert.equal(atlas.meta.status, 'done');
  assert.ok(!logs.some((m) => /waiting for/.test(m)), logs.slice(0, 5).join('\n'));
  assert.ok(Date.now() - t0 < 10_000);
});
