import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Companion, companionAddress } from './idb-grpc.js';

const exec = promisify(execFile);

async function sh(cmd, args, { timeout = 60_000 } = {}) {
  try {
    const { stdout } = await exec(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout });
    return stdout;
  } catch (e) {
    const detail = String(e.stderr || e.message || '').trim().split('\n').pop();
    const err = new Error(`${cmd} ${args.join(' ')} → ${detail}`);
    err.code = e.code;
    throw err;
  }
}

export async function hasBinary(bin) {
  try {
    await exec('which', [bin]);
    return true;
  } catch {
    return false;
  }
}

// Every simulator known to Xcode, newest runtime first.
export async function listSimulators() {
  const json = JSON.parse(await sh('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  const out = [];
  for (const [runtime, devices] of Object.entries(json.devices || {})) {
    const rt = runtime.split('.').pop().replace(/^(\w+)-(\d+)-(\d+)$/, '$1 $2.$3').replace(/-/g, ' ');
    for (const d of devices) out.push({ udid: d.udid, name: d.name, state: d.state, runtime: rt });
  }
  return out.sort((a, b) => (a.state === 'Booted' ? -1 : 0) - (b.state === 'Booted' ? -1 : 0) || b.runtime.localeCompare(a.runtime));
}

// idb prints elements either as one JSON array or as one JSON object per line.
function parseJsonish(out) {
  const s = out.trim();
  if (!s) return [];
  if (s.startsWith('[')) return JSON.parse(s);
  return s.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Normalise an accessibility element from `idb ui describe-all --json`.
function normalize(e) {
  let f = e.frame;
  if (!f && typeof e.AXFrame === 'string') {
    const n = e.AXFrame.match(/-?\d+(\.\d+)?/g)?.map(Number);
    if (n?.length === 4) f = { x: n[0], y: n[1], width: n[2], height: n[3] };
  }
  if (!f) return null;
  // idb lists bars as plain groups; their localized role or id says which bar it is
  const hint = `${e.role_description || ''} ${e.AXLabel || ''} ${e.AXUniqueId || ''}`;
  const bar = /button|cell|link/i.test(e.type || e.role || '') ? null
    : /tab[- ]?(bar|leiste)/i.test(hint) ? 'tab'
    : /nav(igation)?[- ]?(bar|leiste)/i.test(hint) ? 'nav'
    : /tool ?bar|symbolleiste|werkzeugleiste/i.test(hint) ? 'tool' : null;
  return {
    type: String(e.type || e.role || '').replace(/^AX/, ''),
    label: String(e.AXLabel ?? e.title ?? '').trim(),
    value: e.AXValue == null ? '' : String(e.AXValue),
    id: e.AXUniqueId || '',
    enabled: e.enabled !== false,
    x: f.x,
    y: f.y,
    w: f.width,
    h: f.height,
    ...(bar ? { bar } : {}),
    ...(/^(back button|zurück-taste|zurück)$/i.test(e.role_description || '') ? { back: true } : {}),
  };
}

// an SF Symbol name (house, figure.run): what a tab's image is called, not the tab
const SYMBOL = /^[a-z0-9]+(\.[a-z0-9]+)*$/;
// the centre of e lies within the frame of b
const insideOf = (e, b) => e.x + e.w / 2 >= b.x && e.x + e.w / 2 <= b.x + b.w && e.y + e.h / 2 >= b.y && e.y + e.h / 2 <= b.y + b.h;

/**
 * Driver for the iOS Simulator, built on Apple's simctl and Meta's idb.
 * Every driver implements the same small interface, so Android or real devices can be added later:
 *   resolve(), listApps(), launch(), isRunning(), elements(), tap(x, y), type(text), screenshot(file)
 */
export class IosSimulator {
  constructor({ udid = 'booted', bundleId } = {}) {
    this.platform = 'ios-sim';
    this.udid = udid;
    this.bundleId = bundleId;
    this.companion = null; // direct gRPC line to idb_companion, else the idb command line
    this.transport = 'idb';
    this.misses = 0;
  }

  // The fast way when the companion can be reached, the idb command line otherwise.
  // SNAPPCRAWL_IDB=cli always takes the command line.
  async fast(name, viaCompanion, viaCli) {
    if (this.companion) {
      try {
        const r = await viaCompanion(this.companion);
        this.misses = 0;
        return r;
      } catch (e) {
        // twice in a row: the companion is gone or speaks another version · the command line from now on
        if (++this.misses >= 2) {
          this.companion.close();
          this.companion = null;
          this.transport = 'idb';
          this.fellBack = `${name}: ${e.message}`;
        }
      }
    }
    return viaCli();
  }

  async resolve() {
    const sims = await listSimulators();
    const sim = this.udid === 'booted' ? sims.find((s) => s.state === 'Booted') : sims.find((s) => s.udid === this.udid || s.name === this.udid);
    if (!sim) throw new Error('No booted simulator found. Boot one with: xcrun simctl boot "iPhone 16" && open -a Simulator');
    if (sim.state !== 'Booted') await sh('xcrun', ['simctl', 'boot', sim.udid]);
    Object.assign(this, { udid: sim.udid, name: sim.name, runtime: sim.runtime });
    await sh('idb', ['connect', this.udid]).catch(() => {});
    const address = process.env.SNAPPCRAWL_IDB === 'cli' ? null : companionAddress(this.udid);
    if (address) {
      const c = new Companion(address);
      try {
        await c.describeAll(); // answers? then every read, tap and screenshot goes this way
        this.companion = c;
        this.transport = 'idb_companion';
      } catch {
        c.close();
      }
    }
    return this;
  }

  async listApps() {
    const apps = parseJsonish(await sh('idb', ['list-apps', '--udid', this.udid, '--json']));
    return apps
      .map((a) => ({ bundleId: a.bundle_id, name: a.name, type: a.install_type }))
      .sort((a, b) => (a.type === 'system') - (b.type === 'system') || a.name.localeCompare(b.name));
  }

  async launch() {
    await sh('xcrun', ['simctl', 'terminate', this.udid, this.bundleId]).catch(() => {});
    await sh('xcrun', ['simctl', 'launch', this.udid, this.bundleId]);
  }

  // Like a first start: empty the app's data container (documents, settings, caches, cookies)
  // and reset its permissions. The keychain and app group containers stay.
  async resetData() {
    await sh('xcrun', ['simctl', 'terminate', this.udid, this.bundleId]).catch(() => {});
    let dir;
    try {
      dir = (await sh('xcrun', ['simctl', 'get_app_container', this.udid, this.bundleId, 'data'])).trim();
      if (!dir || dir === '(null)') throw new Error('none');
    } catch {
      throw new Error(`no data folder for ${this.bundleId} on this simulator (system apps have none) · reinstall it instead: --reinstall <App.app>`);
    }
    if (!dir.includes(`/Devices/${this.udid}/data/Containers/Data/Application/`)) throw new Error(`unexpected data folder for ${this.bundleId}: ${dir} · not touched`);
    for (const sub of fs.readdirSync(dir)) {
      if (sub.startsWith('.')) continue; // .com.apple.mobile_container_manager.metadata.plist
      const p = path.join(dir, sub);
      if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) fs.rmSync(path.join(p, f), { recursive: true, force: true });
      else fs.rmSync(p, { force: true });
    }
    await sh('xcrun', ['simctl', 'privacy', this.udid, 'reset', 'all', this.bundleId]).catch(() => {});
  }

  // Uninstall and install a build (.app): the app starts like it was just installed.
  async reinstall(appPath) {
    if (!fs.existsSync(appPath)) throw new Error(`${appPath} not found · the .app from Xcode (Product → Show Build Folder) or your CI`);
    await sh('xcrun', ['simctl', 'terminate', this.udid, this.bundleId]).catch(() => {});
    await sh('xcrun', ['simctl', 'uninstall', this.udid, this.bundleId]).catch(() => {});
    await sh('xcrun', ['simctl', 'install', this.udid, appPath]);
  }

  // Bring the running app back to the front without restarting it.
  async activate() {
    await sh('xcrun', ['simctl', 'launch', this.udid, this.bundleId]);
  }

  async isRunning() {
    const out = await sh('xcrun', ['simctl', 'spawn', this.udid, 'launchctl', 'list']).catch(() => '');
    return out.includes(`UIKitApplication:${this.bundleId}`);
  }

  async elements() {
    const raw = await this.fast('describe', (c) => c.describeAll(), async () => parseJsonish(await sh('idb', ['ui', 'describe-all', '--udid', this.udid, '--json'])));
    const els = (Array.isArray(raw) ? raw : [raw]).map(normalize).filter(Boolean);
    // iOS 26 (SwiftUI TabView): the tab bar is listed as one empty group, its tabs are missing.
    // The automation tree (what XCTest sees) has them: read it for the bar only.
    // Sometimes the tabs are there, but named after their symbols (house, gear): the names learned
    // before replace them, else the automation tree is read too.
    const bar = els.find((e) => e.bar === 'tab');
    if (!bar) return els;
    const inBar = els.filter((e) => e !== bar && insideOf(e, bar) && /button/i.test(e.type));
    const named = inBar.map((e) => (SYMBOL.test(e.label) ? { ...e, label: this.tabNames?.get(e.label) || this.tabAt?.get(Math.round((e.x + e.w / 2) / 8)) || e.label } : e));
    if (inBar.length && named.every((e) => !SYMBOL.test(e.label))) {
      const rest = els.filter((e) => !inBar.includes(e));
      return [...rest, ...named.map((e) => ({ ...e, tab: true, ...(e.value === '1' ? { selected: true } : {}) }))];
    }
    const items = await this.tabItems(bar).catch(() => []);
    return items.length ? [...els.filter((e) => !inBar.includes(e)), ...items] : els;
  }

  async tabItems(bar, again = true) {
    const raw = await this.fast('describe', (c) => c.describeAll({ clientType: 5 }), async () => parseJsonish(await sh('idb', ['ui', 'describe-all', '--udid', this.udid, '--client-type', 'xctest', '--json'])));
    const all = (Array.isArray(raw) ? raw : [raw]).filter((e) => e && /^(radiobutton|button)$/i.test(e.type || '')).map((e) => [e.type, normalize(e)]).filter(([, e]) => e && insideOf(e, bar));
    // A tab is a radio button named like the tab, with a button inside named after its symbol
    // (house, gear); while the bar animates only the symbol buttons may be there. Which symbol is
    // which tab is learned once both are seen (or by asking at the tab's place) and kept.
    const names = (this.tabNames ||= new Map());
    const symbol = (l) => SYMBOL.test(l);
    const places = new Map();
    for (const [t, e] of all) {
      const k = Math.round((e.x + e.w / 2) / 8);
      const p = places.get(k) || {};
      if (/^radiobutton$/i.test(t)) p.radio = e;
      else if (symbol(e.label)) p.symbol = e.label;
      else p.button ||= e;
      places.set(k, p);
    }
    const out = [];
    let unsure = false;
    const at = (this.tabAt ||= new Map()); // place → tab name: tabs do not move
    for (const [k, p] of places) {
      if (p.radio && p.symbol) names.set(p.symbol, p.radio.label);
      if (p.radio) at.set(k, p.radio.label);
      p.k = k;
    }
    for (const p of places.values()) {
      let item = p.radio || p.button;
      if (!item && p.symbol) {
        const e = all.find(([, x]) => x.label === p.symbol)[1];
        const known = names.get(p.symbol) || at.get(p.k);
        if (known) item = { ...e, label: known };
        else {
          // below the symbol, at the height of the tab's title: the tab, not its image
          const [x, y] = [Math.round(e.x + e.w / 2), Math.round(Math.max(e.y + e.h + 4, bar.y + bar.h * 0.5))];
          const at = await this.fast('describe', (c) => c.describePoint(x, y), async () => parseJsonish(await sh('idb', ['ui', 'describe-point', '--udid', this.udid, String(x), String(y), '--json']))[0]).catch(() => null);
          const n = at && normalize(at);
          if (n?.label && !symbol(n.label)) {
            names.set(p.symbol, n.label);
            item = n;
          } else {
            item = e;
            unsure = true;
          }
        }
      }
      if (item) out.push({ ...item, type: 'Button', tab: true, ...(item.value === '1' ? { selected: true } : {}) });
    }
    // a symbol nobody could name yet: the bar was still moving, read it once more
    if (unsure && again) {
      await new Promise((r) => setTimeout(r, 300));
      return this.tabItems(bar, false);
    }
    return out.sort((a, b) => a.x - b.x);
  }



  async tap(x, y) {
    const [px, py] = [Math.round(x), Math.round(y)];
    await this.fast('tap', (c) => c.tap(px, py), () => sh('idb', ['ui', 'tap', '--udid', this.udid, String(px), String(py)]));
  }

  // a finger from (x1, y1) to (x2, y2) in `duration` seconds: scrolls a list
  async swipe(x1, y1, x2, y2, { duration = 0.5 } = {}) {
    const r = (v) => Math.round(v);
    await this.fast('swipe', (c) => c.swipe(r(x1), r(y1), r(x2), r(y2), { duration }), () => sh('idb', ['ui', 'swipe', '--udid', this.udid, String(r(x1)), String(r(y1)), String(r(x2)), String(r(y2)), '--duration', String(duration)]));
  }

  async type(text) {
    await sh('idb', ['ui', 'text', '--udid', this.udid, text]);
  }

  async screenshot(file) {
    await this.fast('screenshot', async (c) => fs.writeFileSync(file, await c.screenshot()), () => sh('xcrun', ['simctl', 'io', this.udid, 'screenshot', '--type=png', file]));
  }

  close() {
    this.companion?.close();
  }
}
