import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const DEFAULT_WDA_URL = 'http://127.0.0.1:8100';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/* ---------- devicectl ---------- */

// devicectl's stable interface is its JSON output file, not stdout.
export async function devicectl(args, { timeout = 60_000 } = {}) {
  const tmp = path.join(os.tmpdir(), `snappcrawl-devicectl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    await exec('xcrun', ['devicectl', ...args, '--json-output', tmp, '--quiet'], { timeout, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } catch (e) {
    let info = null;
    try {
      info = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    } catch {}
    const u = info?.error?.userInfo || {};
    const why = u.NSLocalizedDescription?.string || u.NSLocalizedFailureReason?.string || String(e.stderr || e.message || '').trim().split('\n').pop();
    throw new Error(`devicectl ${args.join(' ')} → ${why}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// developerModeStatus is a string in the old fields ("enabled") and an enum object in the new ones ({ enabled: { mode: 1 } }).
const devMode = (v) => (v && typeof v === 'object' ? Object.keys(v)[0] || '' : v || '');

// Physical iOS devices that are reachable right now, wired first. Reads the new `properties`
// dictionary and falls back to the deprecated hardware/device/connectionProperties.
export function parseDevices(json) {
  const out = [];
  for (const d of json?.result?.devices || []) {
    const p = d.properties || {};
    const hw = { ...d.hardwareProperties, ...p.hardware };
    const st = { ...d.deviceProperties, ...p.state };
    const cn = { ...d.connectionProperties, ...p.connection };
    if (hw.reality && hw.reality !== 'physical') continue;
    if ((st.visibilityClass || d.visibilityClass) === 'simulators') continue;
    if (hw.platform && hw.platform !== 'iOS') continue;
    const transport = cn.transportType || '';
    const state = cn.state || cn.tunnelState || '';
    if (!transport || state === 'unavailable') continue; // known to this Mac, but not reachable right now
    const ios = p.software?.osVersionNumber?.stringValue || d.deviceProperties?.osVersionNumber || '';
    out.push({
      id: d.identifier,
      udid: hw.udid || d.identifier,
      name: st.name || hw.marketingName || 'iPhone',
      model: hw.marketingName || hw.productType || '',
      ios,
      transport, // wired | localNetwork
      paired: (cn.pairingState || '') === 'paired',
      developerMode: devMode(p.state?.developerModeStatus) || devMode(d.deviceProperties?.developerModeStatus),
      ddi: st.ddiServicesAvailable ?? d.deviceProperties?.ddiServicesAvailable,
    });
  }
  return out.sort((a, b) => (b.transport === 'wired') - (a.transport === 'wired') || a.name.localeCompare(b.name));
}

export async function listDevices(run = devicectl) {
  return parseDevices(await run(['list', 'devices']));
}

// `list devices` leaves out Developer Mode for real devices; `device info details` has it.
export async function developerMode(id, run = devicectl) {
  const r = (await run(['device', 'info', 'details', '--device', id]))?.result || {};
  return devMode(r.properties?.state?.developerModeStatus) || devMode(r.deviceProperties?.developerModeStatus);
}

export const parseApps = (json) =>
  (json?.result?.apps || [])
    .filter((a) => !a.appClip && !a.hidden)
    .map((a) => ({ bundleId: a.bundleIdentifier, name: a.name || a.bundleIdentifier, type: a.builtByDeveloper ? 'developer' : /^com\.apple\./.test(a.bundleIdentifier) ? 'system' : 'user' }))
    .sort((a, b) => (a.type === 'system') - (b.type === 'system') || a.name.localeCompare(b.name));

/* ---------- WebDriverAgent ---------- */

// iOS error texts are long dictionaries; keep the readable reason.
export function shortReason(msg) {
  const s = String(msg);
  const reason = s.match(/NSLocalizedFailureReason=([^}]+?)(?:, NS\w+=|\}|$)/)?.[1] || s.split(' UserInfo=')[0];
  return reason.replace(/\s+/g, ' ').trim().slice(0, 220);
}

const UNKNOWN = /unknown command|unknown method|unhandled endpoint|not implemented|unsupported operation/i;
const isUnknownRoute = (e) => (e.status === 404 || e.status === 405 || e.status === 501) && UNKNOWN.test(`${e.wdaError} ${e.message}`);
const isBadSession = (e) => /invalid session id|session does not exist|no such session/i.test(`${e.wdaError} ${e.message}`);

export class Wda {
  constructor(url = DEFAULT_WDA_URL) {
    this.url = String(url).replace(/\/+$/, '');
    this.sid = null;
  }

  async req(method, p, body, { timeout = 30_000 } = {}) {
    let res;
    try {
      res = await fetch(this.url + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? `no answer within ${timeout / 1000}s` : e.cause?.code || e.message;
      throw Object.assign(new Error(`WebDriverAgent not reachable at ${this.url} (${why}) · run: snappcrawl wda start`), { code: 'WDA_UNREACHABLE' });
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { value: text };
    }
    const v = json?.value;
    const err = v && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string' ? v : null; // W3C error
    const legacy = typeof json?.status === 'number' && json.status !== 0; // JSONWP status
    if (!res.ok || err || legacy) {
      const msg = err?.message || (typeof v === 'string' ? v : '') || `${res.status} ${text.slice(0, 160)}`;
      // After the iPhone was locked, WDA still answers /status but may no longer drive the UI.
      if (/not authorized for performing ui testing actions/i.test(msg)) {
        throw Object.assign(new Error('WebDriverAgent lost the permission to control the iPhone (it was probably locked) · unlock it, then: snappcrawl wda stop && snappcrawl wda start'), { code: 'WDA_NOT_AUTHORIZED', status: res.status });
      }
      throw Object.assign(new Error(`WebDriverAgent ${method} ${p.replace(/\/session\/[^/]+/, '/session/…')} → ${shortReason(String(msg).split('\n')[0])}`), { status: res.status, wdaError: err?.error || '', detail: String(msg) });
    }
    return json;
  }

  async value(method, p, body, opts) {
    return (await this.req(method, p, body, opts)).value;
  }

  status(timeout = 5000) {
    return this.value('GET', '/status', null, { timeout });
  }

  // /status answers even when WDA may not touch the UI, and after a lock /wda/activeAppInfo
  // quietly falls back to SpringBoard and element queries return []. Two honest signals:
  // the status bar has a height only while WDA can read the screen (fast), and reading the
  // element tree fails with "not authorized" (slow on a busy screen, so only when needed).
  async canControl(timeout = 15_000) {
    try {
      const screen = await this.s('GET', '/wda/screen', null, { timeout: Math.min(timeout, 8000) });
      if (screen?.statusBarSize?.height > 0) return { ok: true };
    } catch (e) {
      if (e.code === 'WDA_NOT_AUTHORIZED' || e.code === 'WDA_UNREACHABLE') return { ok: false, error: e.message, notAuthorized: e.code === 'WDA_NOT_AUTHORIZED' };
    }
    try {
      await this.s('GET', '/source?format=json', null, { timeout });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message, notAuthorized: e.code === 'WDA_NOT_AUTHORIZED' };
    }
  }

  async session(caps = {}) {
    if (this.sid && !Object.keys(caps).length) return this.sid;
    const json = await this.req('POST', '/session', { capabilities: { alwaysMatch: caps, firstMatch: [{}] }, desiredCapabilities: caps }, { timeout: 60_000 });
    this.sid = json.sessionId || json.value?.sessionId;
    if (!this.sid) throw new Error('WebDriverAgent did not return a session id');
    return this.sid;
  }

  // Session-scoped call; a stale session (WDA restarted) is replaced once.
  async s(method, p, body, opts) {
    const sid = await this.session();
    try {
      return await this.value(method, `/session/${sid}${p}`, body, opts);
    } catch (e) {
      if (!isBadSession(e)) throw e;
      this.sid = null;
      return this.value(method, `/session/${await this.session()}${p}`, body, opts);
    }
  }

  // Try endpoint variants in order; remember the first one this WDA understands.
  async variants(key, list) {
    const start = (this.pick ||= {})[key] ?? 0;
    for (let i = start; i < list.length; i++) {
      try {
        const v = await list[i]();
        this.pick[key] = i;
        return v;
      } catch (e) {
        if (!isUnknownRoute(e) || i === list.length - 1) throw e;
      }
    }
  }

  // press at (x1, y1), move to (x2, y2) in `duration` seconds, lift: scrolls a list
  drag(x1, y1, x2, y2, duration = 0.5) {
    return this.s('POST', '/wda/dragfromtoforduration', { fromX: x1, fromY: y1, toX: x2, toY: y2, duration });
  }

  tap(x, y) {
    return this.variants('tap', [
      () => this.s('POST', '/wda/tap', { x, y }),
      () => this.s('POST', '/wda/tap/0', { x, y }),
      () => this.s('POST', '/actions', { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: [{ type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 80 }, { type: 'pointerUp', button: 0 }] }] }),
    ]);
  }

  keys(text) {
    const value = [...String(text)];
    return this.variants('keys', [() => this.s('POST', '/wda/keys', { value }), () => this.s('POST', '/keys', { value })]);
  }

  launch(bundleId) {
    return this.variants('launch', [
      () => this.s('POST', '/wda/apps/launch', { bundleId }),
      async () => {
        this.sid = null;
        await this.session({ bundleId });
      },
    ]);
  }

  activate(bundleId) {
    return this.variants('activate', [() => this.s('POST', '/wda/apps/activate', { bundleId }), () => this.s('POST', '/wda/apps/launch', { bundleId })]);
  }

  // The current alert ({ text, buttons }) or null. WDA answers "no such alert" when there is none.
  async alert() {
    let text;
    try {
      text = await this.s('GET', '/alert/text', null, { timeout: 10_000 });
    } catch (e) {
      if (/no such alert|no alert/i.test(`${e.wdaError} ${e.message}`) || isUnknownRoute(e)) return null;
      throw e;
    }
    if (text == null) return null;
    let buttons = [];
    try {
      buttons = (await this.s('GET', '/wda/alert/buttons')) || [];
    } catch {}
    return { text: String(text), buttons: buttons.map(String) };
  }

  alertAction(action, name) {
    return this.s('POST', `/alert/${action === 'accept' ? 'accept' : 'dismiss'}`, name ? { name } : {});
  }

  async terminate(bundleId) {
    try {
      await this.s('POST', '/wda/apps/terminate', { bundleId });
    } catch (e) {
      if (!isUnknownRoute(e)) throw e;
    }
  }

  // 1 not running · 2 suspended · 3 background · 4 foreground
  appState(bundleId) {
    return this.variants('state', [
      () => this.s('POST', '/wda/apps/state', { bundleId }),
      async () => ((await this.s('GET', '/wda/activeAppInfo'))?.bundleId === bundleId ? 4 : 1),
    ]);
  }

  source() {
    return this.s('GET', '/source?format=json', null, { timeout: 60_000 });
  }

  screen() {
    return this.s('GET', '/wda/screen');
  }

  screenshot() {
    return this.variants('shot', [() => this.value('GET', '/screenshot', null, { timeout: 60_000 }), () => this.s('GET', '/screenshot', null, { timeout: 60_000 })]);
  }
}

/* ---------- element tree ---------- */

const bool = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v === true || v === 1 || v === '1' || v === 'true');

function rectOf(n) {
  const r = n.rect || n.bounds;
  if (r && typeof r === 'object') return { x: +r.x || 0, y: +r.y || 0, w: +(r.width ?? r.w) || 0, h: +(r.height ?? r.h) || 0 };
  if (typeof n.frame === 'string') {
    const m = n.frame.match(/-?\d+(\.\d+)?/g)?.map(Number);
    if (m?.length === 4) return { x: m[0], y: m[1], w: m[2], h: m[3] };
  }
  return null;
}

/**
 * Flatten WDA's /source?format=json tree into the driver element format
 * ({ type, label, value, id, enabled, x, y, w, h }, same as the simulator driver).
 * Elements WDA marks as invisible are dropped; without that flag, elements must at least
 * overlap the app's frame.
 */
export function flattenSource(root) {
  const out = [];
  const screen = rectOf(root || {});
  const overlaps = (r) => !screen || (r.x < screen.x + screen.w && r.x + r.w > screen.x && r.y < screen.y + screen.h && r.y + r.h > screen.y);
  const walk = (n, ctx = {}) => {
    if (!n || typeof n !== 'object') return;
    const r = rectOf(n);
    const flag = n.isVisible ?? n.visible;
    const visible = flag === undefined || flag === null || flag === '' ? r && overlaps(r) : bool(flag, true);
    if (r && visible && r.w > 0 && r.h > 0) {
      const label = String(n.label ?? '').trim();
      const name = n.name == null ? '' : String(n.name);
      out.push({
        type: String(n.type || n.elementType || '').replace(/^XCUIElementType/, ''),
        label,
        value: n.value == null ? '' : String(n.value),
        id: n.rawIdentifier != null ? String(n.rawIdentifier) : name && name !== label ? name : '',
        enabled: bool(n.isEnabled ?? n.enabled, true),
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        // optional flags, only set when true: inside web content, inside the tab bar, selected, a header
        ...(ctx.web ? { web: true } : {}),
        ...(ctx.tab ? { tab: true } : {}),
        ...(ctx.cell ? { cell: true } : {}),
        ...(bool(n.isSelected, false) || /\bselected\b/i.test(n.traits || '') || (ctx.tab && String(n.value) === '1') ? { selected: true } : {}),
        ...(/\bheader\b/i.test(n.traits || '') ? { header: true } : {}),
      });
    }
    const t = String(n.type || '');
    const inner = { web: ctx.web || /WebView$/.test(t), tab: ctx.tab || /TabBar$/.test(t), cell: ctx.cell || /Cell$/.test(t) };
    for (const c of n.children || []) walk(c, inner);
  };
  walk(root);
  return out;
}

/**
 * Driver for a real iPhone over USB: devicectl finds the device and its apps,
 * WebDriverAgent (running on the phone, port-forwarded to wdaUrl) reads the UI and taps.
 * Same interface as IosSimulator.
 */
export class IosDevice {
  constructor({ udid = '', bundleId, wdaUrl = DEFAULT_WDA_URL, run = devicectl } = {}) {
    this.platform = 'ios-device';
    this.udid = udid === 'booted' ? '' : udid || '';
    this.bundleId = bundleId;
    this.run = run;
    this.wda = new Wda(wdaUrl);
  }

  // Device lookup only (no WebDriverAgent needed), e.g. for listing apps.
  async findDevice() {
    const devices = await listDevices(this.run);
    const d = this.udid ? devices.find((x) => [x.udid, x.id, x.name].includes(this.udid)) : devices[0];
    if (!d) {
      throw new Error(this.udid
        ? `No connected iPhone matches "${this.udid}". Connect it by USB, unlock it and tap Trust · snappcrawl devices lists what is connected.`
        : 'No iPhone connected. Connect it by USB, unlock it and tap Trust · snappcrawl devices lists what is connected.');
    }
    Object.assign(this, { udid: d.udid, coreId: d.id, name: d.name, runtime: d.ios ? `iOS ${d.ios}` : 'iOS', info: d });
    return d;
  }

  async resolve() {
    await this.findDevice();
    await this.wda.status();
    await this.wda.session();
    const ctl = await this.wda.canControl();
    if (ctl.notAuthorized) throw new Error(ctl.error);
    const screen = await this.wda.screen().catch(() => null);
    this.statusBar = screen?.statusBarSize?.height || null; // points
    this.scale = screen?.scale || null;
    return this;
  }

  async listApps() {
    if (!this.coreId) await this.findDevice();
    // without --include-default-apps devicectl lists only apps built in Xcode, not App Store apps
    return parseApps(await this.run(['device', 'info', 'apps', '--device', this.coreId, '--include-default-apps', '--include-removable-apps']));
  }

  async launch() {
    await this.wda.terminate(this.bundleId).catch(() => {});
    try {
      await this.wda.launch(this.bundleId);
    } catch (e) {
      // apps from Xcode with a free Apple ID stop opening after 7 days
      if (/invalid code signature|explicitly trusted|inadequate entitlements|profile/i.test(e.detail || e.message)) {
        throw Object.assign(new Error(`iOS refuses to open ${this.bundleId} (signature or provisioning profile) · install the app again from Xcode, or trust the developer: Settings → General → VPN & Device Management`), { hints: ['Apps installed from Xcode with a free Apple ID stop opening after 7 days.'] });
      }
      if (/not installed|unknown bundle|no application/i.test(e.detail || e.message)) throw new Error(`${this.bundleId} is not installed on the iPhone · snappcrawl apps --device lists what is`);
      throw e;
    }
  }

  // Uninstall and install a build (.app signed for this iPhone): starts like the first time.
  // There is no way to only clear an app's data on an iPhone.
  async reinstall(appPath) {
    if (!fs.existsSync(appPath)) throw new Error(`${appPath} not found · the .app from Xcode (Product → Show Build Folder) or your CI`);
    if (!this.coreId) await this.findDevice();
    await this.wda.terminate(this.bundleId).catch(() => {});
    await this.run(['device', 'uninstall', 'app', '--device', this.coreId, this.bundleId], { timeout: 120_000 }).catch(() => {});
    await this.run(['device', 'install', 'app', '--device', this.coreId, appPath], { timeout: 300_000 });
  }

  async isRunning() {
    return Number(await this.wda.appState(this.bundleId)) >= 2;
  }

  // 1 not running · 2 suspended · 3 background (another app in front) · 4 foreground
  async appState() {
    return Number(await this.wda.appState(this.bundleId));
  }

  async activate() {
    await this.wda.activate(this.bundleId);
  }

  alert() {
    return this.wda.alert();
  }

  alertAction(action, button) {
    return this.wda.alertAction(action, button);
  }

  async elements() {
    return flattenSource(await this.wda.source());
  }

  async tap(x, y) {
    await this.wda.tap(x, y);
  }

  async swipe(x1, y1, x2, y2, { duration = 0.5 } = {}) {
    await this.wda.drag(x1, y1, x2, y2, duration);
  }

  async type(text) {
    await this.wda.keys(text);
  }

  async screenshot(file) {
    const b64 = await this.wda.screenshot();
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (!buf.subarray(0, 4).equals(PNG_SIG)) throw new Error('WebDriverAgent returned a screenshot that is not a PNG');
    fs.writeFileSync(file, buf);
  }
}
