import fs from 'node:fs';
import pngjs from 'pngjs';
import { renderWireframe, WIREFRAMES } from '../src/demo.js';
import { totp } from '../src/totp.js';

// A scripted in-memory "app" that speaks the driver interface, so the crawler can be
// tested without Xcode. It has a login with TOTP, a crash, a blocklisted logout and back navigation.
const W = 393;
const H = 852;
const btn = (label, y, type = 'Button') => ({ type, label, value: '', id: '', enabled: true, x: 20, y, w: W - 40, h: 50 });
const text = (label, y = 70) => ({ type: 'StaticText', label, value: '', id: '', enabled: true, x: 20, y, w: 200, h: 30 });
const back = btn('Back', 50);

const SCREENS = {
  splash: { title: 'Pulse', els: [btn('Los geht’s', 700)], taps: { 'Los geht’s': (app) => (app.loggedIn ? 'home' : 'login') } },
  login: { title: 'Anmelden', login: true },
  otp: { title: 'Bestätigung', otp: true },
  home: { title: 'Hallo, Lena', els: [btn('Workouts', 300), btn('Profil', 360), btn('Pro', 420)], taps: { Workouts: 'workouts', Profil: 'profile', Pro: 'CRASH' } },
  workouts: { title: 'Workouts', els: [back, btn('Ganzkörper', 200, 'Cell'), btn('Rücken', 260, 'Cell')], taps: { Ganzkörper: 'detail', Rücken: 'detail' } },
  detail: { title: 'Workout', els: [back, btn('Starten', 700)], taps: { Starten: 'player' } },
  player: { title: 'Player', els: [back] },
  profile: { title: 'Profil', els: [back, btn('Bearbeiten', 300), btn('Einstellungen', 360)], taps: { Bearbeiten: 'edit', Einstellungen: 'settings' } },
  // the same profile with what was behind it still on screen (like a half-open sheet): a timing effect
  profile2: { title: 'Profil', els: [back, btn('Bearbeiten', 300), btn('Einstellungen', 360), text('Orte', 500), text('Privat', 540), text('Arbeit', 580), btn('Neu', 620), btn('Reiseführer', 680)], taps: { Bearbeiten: 'edit', Einstellungen: 'settings' } },
  news: { title: 'Neuigkeiten', els: [back] },
  edit: { title: 'Profil bearbeiten', els: [back] },
  settings: { title: 'Einstellungen', els: [back, btn('Mitteilungen', 300), btn('Abmelden', 600)], taps: { Mitteilungen: 'notif', Abmelden: 'LOGOUT' } },
  notif: { title: 'Mitteilungen', els: [back] },
  long: { title: 'Alle Übungen', els: [back] },
  secret: { title: 'Geheim', els: [back] },
};

const WIRE = { profile2: 'profile', news: 'home', splash: 'splash', login: 'login', home: 'home', workouts: 'workouts', detail: 'detail', player: 'player', profile: 'profile', edit: 'edit', settings: 'settings', notif: 'notif', otp: 'login' };

// Optional real-world noise (all off by default):
//   sheet: 'first' | 'always'  an onboarding sheet ("Alles klar") over the start screen
//   consent: true              a cookie banner until someone decides
//   alert: true                a notification permission prompt when home appears
//   external: true             home has "Website" (opens Safari), profile a web link "Impressum"
//   ad: true                   a web ad banner on every screen whose text changes on every read
//   onboarding: true           a welcome screen on the very first launch only ("Loslegen")
//   flaky: n                   the n-th tap on "Profil" (home) shows the profile with leftovers behind it
//   extra: true                home has a new button "Neu" (a new screen, before "Workouts")
//   lag: n                     after a tap that opens a screen, the next n reads show the old and the new
//                              screen at once (a push animation), the one after an empty screen (loading)
//   changes: { screen: { label: { label, y, to } } }  a button renamed, moved, or leading elsewhere
//   pin: { code, pad }         an app lock on every start: a number pad (pad: true, sends on the
//                              last digit) or a secure field with "Weiter"; a wrong PIN is counted
//   feed: true                 home has a news cell and an ad cell whose texts change on every read
const HEADLINES = ['Dow erases losses to end positive', 'DAX klettert auf Rekordhoch', 'Ölpreis fällt den dritten Tag'];
const SPONSORS = ['Fisher Investments', 'günstig-heizen.de', 'Depot24'];
const ADS = ['Jetzt Depot eröffnen', 'Nur heute: 0 € Ordergebühr', 'Krypto ab 1 €'];
const sheetEls = () => [text('Neu: Watchlists', 300), text('Behalte deine Kurse im Blick', 340), btn('Alles klar', 700)];
const consentEls = () => [text('Ihre Privatsphäre ist uns wichtig', 200), text('Wir verwenden Cookies, wenn Sie auf Alle akzeptieren tippen.', 260), btn('Alle akzeptieren', 600), btn('Alle ablehnen', 660), { ...btn('Datenschutzerklärung', 720, 'Link'), web: true }];

export class FakeApp {
  constructor({ user = 'lena@pulse.app', pass = 'secret', secret = 'JBSWY3DPEHPK3PXP', sheet = false, consent = false, alert = false, external = false, ad = false, onboarding = false, feed = false, flaky = 0, extra = false, lag = 0, changes = {}, pin = null, restore = false, long = 0 } = {}) {
    Object.assign(this, { user, pass, secret, sheet, consent, alertOn: alert, external, ad, onboarding, feed, flaky, extra, lag, changes, pin, restore, long });
    this.offset = 0; // scroll position of the long list (long: its number of rows)
    this.swipes = 0;
    this.pinFails = 0;
    this.pinOk = 0;
    this.pinTyped = '';
    this.moving = null; // { from, reads } while a screen is still animating in
    this.profileTaps = 0;
    this.feedReads = 0;
    this.onboarded = false;
    this.adReads = 0;
    this.overlay = null;
    this.consentDecision = null;
    this.alertAnswer = null;
    this.sheetsShown = 0;
    this.front = 'app';
    this.platform = 'fake';
    this.name = 'Fake iPhone';
    this.runtime = 'iOS 0.0';
    this.udid = 'fake';
    this.loggedIn = false;
    this.running = false;
    this.stack = [];
    this.taps = [];
    this.fields = {};
    this.focus = null;
  }
  get screen() {
    return this.stack.at(-1);
  }
  async resolve() {
    return this;
  }
  async listApps() {
    return [{ bundleId: 'com.pulse.app', name: 'Pulse' }];
  }
  async launch() {
    this.front = 'app';
    // restore: like iOS Settings, a logged-in app reopens on the screen it was left on
    const keep = this.restore && this.running && this.loggedIn && this.stack.length > 2;
    if (keep) this.reopened = (this.reopened || 0) + 1;
    else this.stack = ['splash'];
    this.running = true;
    this.fields = {};
    this.overlay = this.onboarding && !this.onboarded ? 'welcome' : this.consent && !this.consentDecision ? 'consent' : this.sheet === 'always' || (this.sheet && !this.sheetsShown) ? 'sheet' : null;
    if (this.overlay === 'sheet') this.sheetsShown++;
    if (!this.overlay && this.pin && this.loggedIn) this.overlay = 'pin';
    this.pinTyped = '';
  }
  checkPin() {
    if (this.pinTyped === this.pin.code) {
      this.pinOk++;
      this.overlay = null;
    } else this.pinFails++;
    this.pinTyped = '';
  }
  async activate() {
    this.front = 'app';
  }
  // like the simulator driver: data and permissions gone, the app starts like the first time
  async resetData() {
    this.resets = (this.resets || 0) + 1;
    Object.assign(this, { running: false, onboarded: false, consentDecision: null, alertAnswer: null, sheetsShown: 0, loggedIn: false });
  }
  async reinstall(appPath) {
    this.reinstalled = appPath;
    await this.resetData();
  }
  // permission prompt, as WDA's alert endpoints see it
  get alertVisible() {
    return this.alertOn && !this.alertAnswer && this.front === 'app' && this.screen === 'home';
  }
  alertText() {
    return this.alertVisible ? '„Pulse“ möchte dir Mitteilungen senden' : null;
  }
  answerAlert(button) {
    this.alertAnswer = button;
  }
  async isRunning() {
    return this.running;
  }
  async elements() {
    if (this.moving) {
      const { from, reads } = this.moving;
      const now = this.screenEls();
      if (reads > 1) {
        this.moving.reads--;
        // both lists on screen, sliding: the new one comes in from the right, the old one leaves
        const shift = (reads - 1) * 60;
        const old = (SCREENS[from]?.els || []).filter((e) => !now.some((x) => x.label === e.label)).map((e) => ({ ...e, x: e.x - (W - shift) / 2 }));
        return [now[0], ...now.slice(1).map((e) => ({ ...e, x: e.x + shift })), ...old];
      }
      this.moving = null;
      return now.slice(0, 1); // the application only: still loading
    }
    return this.screenEls();
  }
  screenEls() {
    if (!this.running) return [{ type: 'Application', label: 'SpringBoard', x: 0, y: 0, w: W, h: H, enabled: true, value: '', id: '' }];
    if (this.front === 'safari') return [{ type: 'Application', label: 'Safari', x: 0, y: 0, w: W, h: H, enabled: true, value: '', id: '' }, text('pulse.app'), { ...btn('pulse.app/help', 200, 'Link'), web: true }];
    const appEl = { type: 'Application', label: 'Pulse', x: 0, y: 0, w: W, h: H, enabled: true, value: '', id: '' };
    if (this.overlay === 'sheet') return [appEl, ...sheetEls()];
    if (this.overlay === 'welcome') return [appEl, text('Willkommen bei Pulse', 200), btn('Loslegen', 700)];
    if (this.overlay === 'pin') {
      if (!this.pin.pad) return [appEl, text('Bitte PIN eingeben', 120), { ...btn('PIN', 200, 'SecureTextField'), value: '•'.repeat(this.pinTyped.length) }, btn('Weiter', 300)];
      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d, i) => ({ ...btn(d, 400 + Math.floor(i / 3) * 80), x: i === 9 ? 160 : 40 + (i % 3) * 120, w: 80, h: 70 }));
      return [appEl, text('Gib deine PIN ein', 120), text('•'.repeat(this.pinTyped.length) || ' ', 200), ...keys];
    }
    if (this.overlay === 'consent') return [appEl, ...consentEls()];
    const s = SCREENS[this.screen];
    const els = [appEl, text(s.title)];
    if (s.login) els.push({ ...btn('E-Mail', 200, 'TextField'), value: this.fields.user || '' }, { ...btn('Passwort', 280, 'SecureTextField') }, btn('Anmelden', 400));
    else if (s.otp) els.push({ ...btn('Code', 200, 'TextField'), value: this.fields.code || '' }, btn('Bestätigen', 300));
    else {
      const ch = this.changes[this.screen] || {};
      els.push(...s.els.map((e) => (ch[e.label] ? { ...e, label: ch[e.label].label ?? e.label, y: ch[e.label].y ?? e.y, orig: e.label } : e)));
    }
    if (this.long && this.screen === 'home') els.push(btn('Alle Übungen', 480));
    if (this.screen === 'long') els.push(...this.longRows());
    if (this.external && this.screen === 'home') els.push(btn('Website', 480));
    if (this.extra && this.screen === 'home') els.push(btn('Neu', 250));
    if (this.feed && this.screen === 'home') {
      const n = this.feedReads++;
      els.push({ ...btn('', 540, 'Cell'), h: 60 }, text(HEADLINES[n % 3], 555), text(`vor ${n % 50 + 1} Std.`, 575));
      els.push({ ...btn('', 610, 'Cell'), h: 60 }, text(`Ad by ${SPONSORS[n % 3]}`, 625), { ...btn('ANZEIGE', 625), x: 300, w: 60, h: 30 });
    }
    if (this.external && this.screen === 'profile') els.push({ ...btn('Impressum', 480, 'Link'), web: true });
    if (this.ad) {
      // above the title, so a name taken from the top would pick it up
      const n = this.adReads++;
      els.push({ ...text(`Anzeige · ${ADS[n % ADS.length]}`, 20), h: 34, web: true }, { ...btn('Weitere Informationen', 20, 'Link'), x: 300, w: 80, h: 30, web: true }, { ...btn(`Ad ${n % 7}`, 20), x: 250, w: 40, h: 30, web: true });
    }
    if (this.alertVisible) els.push({ type: 'Alert', label: this.alertText(), value: '', id: '', enabled: true, x: 40, y: 340, w: W - 80, h: 180, alert: true }, { ...btn('Nicht erlauben', 470), x: 40, w: 150, alert: true }, { ...btn('Erlauben', 470), x: 200, w: 150, alert: true });
    return els;
  }
  async tap(x, y) {
    const hits = (await this.elements()).filter((e) => e.type !== 'Application' && e.type !== 'Alert').filter((e) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
    const el = (this.restore && hits.find((e) => e.type !== 'StaticText')) || hits[0]; // restore: a title over the back button does not take its tap
    if (!el) return;
    if (this.alertVisible && !el.alert) return; // the prompt blocks the app
    this.taps.push(el.label);
    if (el.alert) return this.answerAlert(el.label === 'Erlauben' ? 'accept' : 'dismiss');
    if (this.overlay === 'sheet') {
      if (el.label === 'Alles klar') this.overlay = null;
      return;
    }
    if (this.overlay === 'pin') {
      if (this.pin.pad && /^\d$/.test(el.label)) {
        this.pinTyped += el.label;
        if (this.pinTyped.length === this.pin.code.length) this.checkPin();
      } else if (el.type === 'SecureTextField') this.focus = 'pin';
      else if (el.label === 'Weiter') this.checkPin();
      return;
    }
    if (this.overlay === 'welcome') {
      if (el.label === 'Loslegen') {
        this.onboarded = true;
        this.overlay = null;
      }
      return;
    }
    if (this.overlay === 'consent') {
      if (/akzeptieren|ablehnen/.test(el.label)) {
        this.consentDecision = el.label;
        this.overlay = null;
      }
      if (el.type === 'Link') this.front = 'safari';
      return;
    }
    if (el.type === 'Link' || el.label === 'Website') {
      this.front = 'safari';
      return;
    }
    const s = SCREENS[this.screen];
    if (/TextField/.test(el.type)) {
      this.focus = el.type === 'SecureTextField' ? 'pass' : s.otp ? 'code' : 'user';
      return;
    }
    if (el.label === 'Back') {
      if (this.stack.length > 1) this.stack.pop();
      return;
    }
    if (s.login && el.label === 'Anmelden') {
      if (this.fields.user === this.user && this.fields.pass === this.pass) this.stack.push('otp');
      this.fields = {};
      return;
    }
    if (s.otp && el.label === 'Bestätigen') {
      if (this.fields.code === totp(this.secret)) {
        this.loggedIn = true;
        this.stack = ['splash', 'home'];
      }
      return;
    }
    if (this.extra && this.screen === 'home' && el.label === 'Neu') return void this.stack.push('news');
    if (this.long && this.screen === 'home' && el.label === 'Alle Übungen') return void this.stack.push('long');
    if (this.screen === 'long' && /^Übung [A-Z]$/.test(el.label)) return void this.stack.push(el.label === 'Übung R' ? 'secret' : 'detail'); // R: the 18th row
    if (this.screen === 'home' && el.label === 'Profil' && ++this.profileTaps === this.flaky) return void this.stack.push('profile2');
    const ch = el.orig ? this.changes[this.screen]?.[el.orig] : null;
    let target = ch?.to || s.taps?.[el.orig || el.label];
    if (typeof target === 'function') target = target(this);
    if (target === 'CRASH') this.running = false;
    else if (target === 'LOGOUT') {
      this.loggedIn = false;
      this.stack = ['splash'];
    } else if (target) {
      if (this.lag) this.moving = { from: this.screen, reads: this.lag + 1 };
      this.stack.push(target);
    }
  }
  // the long list as a picture at 1x: a white title area, rows in their own gray, the home indicator
  longPicture() {
    const { PNG } = pngjs;
    const p = new PNG({ width: W, height: H });
    const set = (y0, y1, rgb) => {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) for (let x = 0; x < W; x++) p.data.set([...rgb, 255], (y * W + x) * 4);
    };
    set(0, H, [242, 242, 247]);
    for (let i = 0; i < this.long; i++) {
      const y = 120 + i * 50 - this.offset;
      const g = 40 + ((i * 37) % 180);
      set(Math.max(100, y), Math.min(818, y + 44), [g, 255 - g, (g * 3) % 255]);
    }
    set(0, 100, [255, 255, 255]);
    set(818, H, [250, 250, 250]);
    return PNG.sync.write(p);
  }
  async type(t) {
    if (this.overlay === 'pin' && this.focus === 'pin') return void (this.pinTyped += t);
    if (this.focus) this.fields[this.focus] = (this.fields[this.focus] || '') + t;
  }
  // long: a list taller than the screen, rows "Übung A", "Übung B" … of 50 pt from y 120, the content between the title
  // (up to 100) and the home indicator (from 818) scrolls; only rows in that area are listed.
  longRows() {
    const out = [];
    for (let i = 0; i < this.long; i++) {
      const y = 120 + i * 50 - this.offset;
      if (y + 44 > 100 && y < 818) out.push({ ...btn(`Übung ${String.fromCharCode(65 + i)}`, y, 'Cell'), h: 44 });
    }
    return out;
  }
  get maxOffset() {
    return Math.max(0, 120 + this.long * 50 - 818);
  }
  async swipe(x1, y1, x2, y2) {
    this.swipes++;
    if (this.screen !== 'long' || this.overlay) return;
    this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + (y1 - y2) * 1.4)); // a little momentum
  }
  async screenshot(file) {
    if (this.screen === 'long' && !this.overlay) return void fs.writeFileSync(file, this.longPicture());
    const key = WIRE[this.screen] || 'splash';
    const spec = WIREFRAMES[key];
    fs.writeFileSync(file, renderWireframe(spec('#3b6ef5')));
  }
}
