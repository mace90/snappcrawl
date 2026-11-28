#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { annotate } from '../src/ai.js';
import { banner, checklist } from '../src/banner.js';
import { GLOBAL_FILE, LOCAL_FILE, TEMPLATE, loadConfig } from '../src/config.js';
import * as control from '../src/control.js';
import { crawl, formatEta } from '../src/crawler.js';
import { createDemo } from '../src/demo.js';
import { buildReport } from '../src/diff.js';
import { crawlPair, secondSimulator } from '../src/pair.js';
import { listAllDevices, makeDriver } from '../src/drivers/index.js';
import { DEFAULT_WDA_URL } from '../src/drivers/ios-device.js';
import * as legacy from '../src/legacy.js';
import { applyReview, decisionOf, hintLines, needsReview, renderReport, reportFileName, reviewState } from '../src/report.js';
import { startServer } from '../src/server.js';
import { startMcp } from '../src/mcp.js';
import { EXIT, summarize, summaryMarkdown } from '../src/summary.js';
import { baselineLimits, checkResult } from '../src/check.js';
import { initAgents } from '../src/agents.js';
import { buildApp, buildRef, installApp } from '../src/build.js';
import { junitXml } from '../src/junit.js';
import { setup } from '../src/setup.js';
import { Store } from '../src/store.js';
import * as t from '../src/term.js';
import { startForwarder } from '../src/usbmux.js';
import * as wdaKit from '../src/wda.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const say = t.print;

const HELP = `
${t.bold('snappcrawl')} ${t.gray('v' + pkg.version)}  crawl your app, map every screen, diff builds

${t.bold('Start')}
  snappcrawl                  open the web UI (same as snappcrawl ui) · everything works from there
  setup                       fix what is missing, step by step
  doctor                      check Xcode, idb, simulators, the iPhone and WebDriverAgent

${t.bold('Devices')}
  devices                     list simulators and iPhones
  boot <simulator>            boot a simulator, e.g. snappcrawl boot "iPhone 17"
  apps                        list apps on the simulator, or on an iPhone with --device
  wda setup                   build WebDriverAgent for the connected iPhone (--team <TEAM_ID>)
  wda start                   start it on the iPhone and forward port 8100 (crawl does this itself)
  wda stop                    stop it
  wda status                  is it set up, running, in control

${t.bold('Crawl and compare')}
  check                       crawl and compare with the baseline in one go (first run: becomes it)
                              exit 0 passed · 1 broken · 2 changes to review · 3 needs a person · 4 setup
  crawl                       explore the app and capture every screen (options below)
  runs                        list runs
  runs rm <run>               delete a run and its comparisons
  baseline <run>              make a run the baseline of its app (no run: show baselines)
  diff [base] [head]          compare two runs (default: baseline vs the newest run after it)
  review [base] [head]        list the changes and their decisions
  review <id|all> <approve|reject|undo> [base] [head]
                              decide like in the UI · "all" = every open change
  report [base] [head]        write a standalone HTML report (--full: graph and images)
  notes [base] [head]         add model notes to the changes (needs an ai provider)
  ignore <screen>             leave a screen out of the pixel comparison of its app
                              --area x,y,w,h (points): only that area, e.g. an animation
  ignore rm <n>               remove a rule · ignore alone lists them (--bundle: another app)

${t.bold('More')}
  ui                          open the web UI · --port <n> --no-open
  init                        write ${LOCAL_FILE} in this folder
  demo                        create two sample runs to try the UI without a device
  config                      show settings · config set <key> <value>, e.g. ai.provider anthropic
  migrate                     move data from the previous name to the snappcrawl locations
  help                        this text · -v, --version · --debug shows stack traces

${t.bold('Crawl options')}
  --bundle <id>               app bundle id (or app.bundleId in ${LOCAL_FILE})
  --then <id>                 two builds installed side by side: crawl --bundle as the baseline,
                              then this app against it, then compare (e.g. --bundle com.firma.app --then com.firma.app.beta)
  --parallel <simulator>      with --then: the second build on this simulator, both at the same time
                              (about half the time; the test build does not follow the baseline)
  --against <id>              compare this run with the baseline of another app (the second build)
  --udid <udid|name>          simulator (default: the booted one)
  --device <udid|name>        real iPhone over USB
  --label <text>              tag the run, e.g. v2.4.0
  --max-depth <n>  --max-screens <n>  --minutes <n>
  --mfa <none|totp|prompt|manual>
  --no-follow                 explore freely; by default a run with a baseline repeats it first
                              (its screens in its order, a tap that lands elsewhere tried once more)
  --intro <keep|skip|fresh>   screens an app shows only on its first start (default: like the baseline, else keep)
                              skip: tap through the intro once, allow prompts, accept cookies, restart, then crawl
                              fresh: reset the app before the crawl, so every run (and every comparison) has the intro
  --reinstall <App.app>       with --intro fresh: uninstall and install this build (needed on an iPhone to skip the manual step)
  --prepare                   pause after launch: decide cookie banners, finish onboarding, open the start screen
  --alerts <dismiss|accept|pause>   permission prompts (default: dismiss)
  --dismiss <a,b,c>           labels of buttons that close onboarding sheets and hints
  --block <a,b,c>             extra words that are never tapped
  --prefer <a,b,c>            labels to tap before everything else, in this order
  --max-per-list <n>          only the first n cells of each list (default: all)
  --scroll                    scroll long screens page by page: tap what is below, compare the whole page
  --scroll-pages <n>          with --scroll: at most n pages below the first (default 5)
  --diff                      compare against the baseline when done

${t.bold('Build from Xcode')} ${t.gray('(check and crawl, simulator)')}
  --build                     build the app in this folder for the Simulator, install it, then crawl
  --base-ref <git ref>        also build that state (e.g. main) in a temporary worktree and crawl it first
                              as the baseline: compares your working tree with it, nothing else needed
  --project <path>  --scheme <name>  --configuration <Debug|Release>  --set KEY=VALUE (build setting)

${t.bold('For agents and CI')}
  --json                      check, diff, runs, apps, devices, doctor: one JSON document on stdout, the log on stderr
  --markdown                  diff: the result as Markdown (a PR comment, a CI summary)
  --junit <file>              check, diff: one JUnit test case per screen (on GitHub Actions the job summary is written too)
  --no-input                  never wait for a person (automatic without a terminal or with CI set): exit 3
  mcp                         MCP server on stdio for coding agents (Claude Code, Codex, Copilot, Cursor …)
  init --agents               tell the agents in this repository about snappcrawl (AGENTS.md, CLAUDE.md, .mcp.json …)
                              --npx: MCP configs run npx -y snappcrawl mcp (no global install needed)

${t.bold('Real iPhone')}
  1. Xcode → Settings → Accounts: sign in with your Apple ID (a free one works).
  2. iPhone: connect by USB, unlock, tap Trust; Settings → Privacy & Security → Developer Mode on.
  3. snappcrawl setup, or in the web UI: Setup → select the iPhone → Set up WebDriverAgent.
     The team id (10 characters) is read from your signing certificate, or see
     Xcode → Settings → Accounts → your Apple ID, or developer.apple.com/account → Membership.
`;

const { values: opt, positionals: pos } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    bundle: { type: 'string' },
    udid: { type: 'string' },
    device: { type: 'string' },
    label: { type: 'string' },
    'max-depth': { type: 'string' },
    'max-screens': { type: 'string' },
    minutes: { type: 'string' },
    mfa: { type: 'string' },
    prepare: { type: 'boolean' },
    alerts: { type: 'string' },
    dismiss: { type: 'string' },
    block: { type: 'string' },
    prefer: { type: 'string' },
    intro: { type: 'string' },
    'no-follow': { type: 'boolean' },
    reinstall: { type: 'string' },
    'max-per-list': { type: 'string' },
    scroll: { type: 'boolean' },
    'scroll-pages': { type: 'string' },
    then: { type: 'string' },
    area: { type: 'string' },
    parallel: { type: 'string' },
    against: { type: 'string' },
    team: { type: 'string' },
    'bundle-id': { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string' },
    'no-open': { type: 'boolean' },
    diff: { type: 'boolean' },
    ai: { type: 'boolean' },
    full: { type: 'boolean' },
    out: { type: 'string' },
    debug: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    json: { type: 'boolean' },
    markdown: { type: 'boolean' },
    'no-input': { type: 'boolean' },
    agents: { type: 'boolean' },
    npx: { type: 'boolean' },
    build: { type: 'boolean' },
    'base-ref': { type: 'string' },
    project: { type: 'string' },
    scheme: { type: 'string' },
    configuration: { type: 'string' },
    set: { type: 'string', multiple: true },
    junit: { type: 'string' },
  },
});

// --json: one JSON document on stdout, everything else (log, tables) on stderr.
const stdoutWrite = process.stdout.write.bind(process.stdout);
if (opt.json) process.stdout.write = process.stderr.write.bind(process.stderr);
const emit = (obj) => stdoutWrite(JSON.stringify(obj, null, 2) + '\n');
// Nobody to press enter (an agent, CI, --json, --no-input): a crawl that needs a person stops
// with exit code 3 and says what to set, instead of waiting forever.
const interactive = !!process.stdin.isTTY && !opt.json && !opt['no-input'] && !process.env.CI;
const NEEDS_INPUT = 'needs a person';

const cmd = pos[0] || 'ui';
const cfg = loadConfig(opt.config);
const store = new Store(cfg.outDir).ensure();
const wdaUrl = () => cfg.device.wdaUrl || DEFAULT_WDA_URL;
const list = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
const expected = (message) => Object.assign(new Error(message), { expected: true });

// --device = real iPhone, --udid = simulator, otherwise device.platform from the config.
function driverOpts() {
  const platform = opt.device ? 'ios-device' : opt.udid ? 'ios-sim' : cfg.device.platform;
  const udid = opt.device || opt.udid || (cfg.device.platform === platform ? cfg.device.udid : '');
  return { platform, udid, wdaUrl: wdaUrl() };
}

function openBrowser(url) {
  const bin = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(bin, [url], () => {});
}

let checking = false;

// The end of `snappcrawl check`: the first run of an app becomes its baseline, every later one
// is compared with it. Exit code 0 passed, 1 broken or rejected, 2 changes to review.
function finishCheck(atlas, pair) {
  const r = checkResult({ atlas, pair, store, cfg });
  if (r.verdict === 'baseline') {
    process.exitCode = r.crashes ? 1 : 0;
    if (opt.json) return emit(r);
    say(`\n  ${t.ok(`baseline saved · ${r.screens} screens`)}${r.crashes ? t.red(` · ${r.crashes} crash${r.crashes === 1 ? '' : 'es'}`) : ''} · ${r.run}\n  ${t.gray('change the app, then run snappcrawl check again')}\n`);
    return;
  }
  process.exitCode = EXIT[r.verdict];
  writeCiFiles(r, pair?.report || store.readReport(r.base.run, r.head.run));
  if (opt.json) return emit(r);
  printReport(pair?.report || store.readReport(r.base.run, r.head.run));
  say(`  ${{ passed: t.green, changes: t.yellow, broken: t.red, failed: t.red }[r.verdict](r.verdict)}`);
  for (const n of r.next) say(`  ${t.gray('·')} ${n}`);
  say();
}

// --junit <file>; on GitHub Actions the Markdown result goes to the job summary by itself
function writeCiFiles(r, report) {
  if (opt.junit) fs.writeFileSync(opt.junit, junitXml(r, report));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(r) + '\n');
}

const RESULT = { passed: t.green, failed: t.red, 'in review': t.yellow };
const DECISION = { approved: t.green, rejected: t.red, open: t.white, passed: t.green, skipped: t.gray };
const STATUS = { changed: 'changed', new: 'new', bad: 'broken', skipped: 'one-time' };
const TONE = { changed: t.yellow, new: t.cyan, bad: t.red, skipped: t.gray };
const pct = (r) => (r != null ? (r * 100).toFixed(2) + ' %' : '');

function printReport(r) {
  const s = r.summary;
  t.title('diff', `${r.base.label || r.base.id} → ${r.head.label || r.head.id}`);
  t.table([[t.green('same'), s.same], [t.yellow('changed'), s.changed], [t.cyan('new'), s.new], [t.red('broken'), s.bad], ...(s.skipped ? [[t.gray('one-time'), s.skipped]] : [])]);
  const rows = r.screens.filter((x) => x.status !== 'same').map((x) => [x.id, x.name, TONE[x.status](x.reason || STATUS[x.status]), pct(x.ratio), r.notes[x.id]?.summary ? t.gray(r.notes[x.id].summary) : '']);
  if (rows.length) {
    say();
    t.table(rows, { head: ['id', 'screen', 'status', 'Δ px', 'note'] });
  }
  const hints = r.screens.filter((x) => x.hints);
  if (hints.length) {
    say(`\n  ${t.bold('buttons')}`);
    for (const x of hints) for (const l of hintLines(x)) say(`  ${t.gray(x.id)}  ${x.name} · ${l}`);
  }
  const ign = r.screens.filter((x) => x.ignored?.length);
  if (ign.length) say(`\n  ${t.gray(`left out of the pixel comparison: ${ign.map((x) => `${x.name} (${x.ignored.some((a) => !a) ? 'all' : `${x.ignored.length} area${x.ignored.length === 1 ? '' : 's'}`})`).join(', ')} · snappcrawl ignore`)}`);
  say(`\n  ${t.gray('review:')} snappcrawl  ${t.gray('(web UI) · or')} snappcrawl review\n`);
}

// Explicit runs work in any direction; otherwise the same default as the UI (store.defaultPair).
function pickRuns(baseArg, headArg) {
  if (headArg) {
    const headRun = store.listRuns().find((r) => r.id === headArg && r.status === 'done');
    if (!headRun) throw expected(`no finished run "${headArg}" · snappcrawl runs lists them`);
    const base = baseArg || store.baselineFor(headRun.app);
    if (!base) throw expected(`${headRun.appName || headRun.app} has no baseline yet · pass base and head explicitly`);
    return { base, head: headRun.id };
  }
  const pair = store.defaultPair();
  if (pair.error) throw expected(pair.error);
  return { base: baseArg || pair.base, head: pair.head };
}

// Reuse the stored report so review decisions made in the UI or CLI are kept.
const loadReport = ({ base, head }) => store.readReport(base, head) || buildReport({ store, baseId: base, headId: head, cfg });

function printState(r) {
  const st = reviewState(r);
  say(`  ${t.gray('reviewed')} ${st.reviewed}/${st.total}  ${t.gray('approved')} ${st.approved}  ${t.gray('rejected')} ${st.rejected}  ${t.gray('result')} ${RESULT[st.result](st.result)}`);
}

const commands = {
  async help() {
    say(HELP);
  },

  async ui() {
    process.stdout.write(banner(pkg.version));
    await checklist({ cfg, print: say });
    const port = Number(opt.port || 4747);
    const { port: actual } = await startServer({ store, cfg, port, version: pkg.version });
    const url = `http://localhost:${actual}`;
    say(`\n  ${t.bold('ui')}  ${t.gray('→')} ${t.white(url)}  ${t.gray(`(ctrl-c to stop${actual !== port ? ` · port ${port} was busy` : ''})`)}\n`);
    if (!opt['no-open']) openBrowser(url);
  },

  async setup() {
    process.stdout.write(banner(pkg.version));
    await setup({ cfg });
  },

  async doctor() {
    t.title('doctor');
    const results = await checklist({ cfg, print: say });
    say();
    if (results.some((r) => r.state === 'fail')) process.exitCode = 1;
    if (opt.json) emit({ ready: !results.some((r) => r.state === 'fail'), checks: results.map(({ id, group, label, state, value, fix }) => ({ id, group, label, state, value, fix })) });
  },

  async devices() {
    t.title('devices', 'simulators and iPhones');
    const { sims, devices, errors } = await listAllDevices();
    const phones = await Promise.all(devices.map((d) => control.iphoneStatus(d, { wdaUrl: wdaUrl() })));
    const rows = [
      ...phones.map((d) => [t.cyan(d.transport === 'wired' ? 'usb' : 'wi-fi'), d.paired ? t.green('● connected') : t.yellow('● not trusted'), d.name, t.gray(`iOS ${d.ios} · ${d.lock} · dev mode ${d.developerMode === 'enabled' ? 'on' : d.developerMode}`), t.gray(d.wda.control ? 'wda ready' : d.wda.built ? 'wda off' : 'wda not set up')]),
      ...sims.map((s) => ['simulator', s.state === 'Booted' ? t.green('● booted') : t.gray('○ ' + s.state.toLowerCase()), s.name, t.gray(s.runtime), t.gray(s.udid)]),
    ];
    if (rows.length) t.table(rows, { head: ['type', 'state', 'name', 'details', ''] });
    for (const e of errors) say('  ' + t.warn(e));
    say();
    if (opt.json) emit({ simulators: sims, iphones: phones.map((d) => ({ name: d.name, udid: d.udid, ios: d.ios, connected: !!d.paired, lock: d.lock, developerMode: d.developerMode, wdaReady: !!d.wda?.control })), errors });
  },

  async boot() {
    if (!pos[1]) throw expected('which simulator? · snappcrawl boot "iPhone 17" (snappcrawl devices lists them)');
    const sim = await control.bootSimulator(pos[1], { log: t.logLine });
    say('  ' + t.ok(`${sim.name} · ${sim.runtime} · booted`));
  },

  async apps() {
    const d = makeDriver(driverOpts());
    await (d.findDevice ? d.findDevice() : d.resolve());
    t.title('apps', `${d.name} · ${d.runtime}`);
    const apps = await d.listApps();
    t.table(apps.map((a) => [a.name, a.bundleId, t.gray(a.type || '')]), { head: ['name', 'bundle id', 'type'] });
    say();
    if (opt.json) emit({ device: d.name, udid: d.udid, apps: apps.map((a) => ({ ...a, baseline: store.baselineFor(a.bundleId) })) });
  },

  async init() {
    if (opt.agents) {
      const r = initAgents({ bundleId: opt.bundle || cfg.app.bundleId, npx: !!opt.npx });
      if (opt.json) return emit(r);
      t.title('init --agents', 'coding agents in this repository know about snappcrawl');
      t.table(r.files.map((f) => [f.file, f.state.startsWith('unchanged') ? t.gray(f.state) : t.green(f.state), t.gray(f.for)]), { head: ['file', '', 'read by'] });
      say(`\n  ${t.gray('per machine, for agents that keep MCP servers outside the repository:')}`);
      for (const c of r.commands) say(`  ${c.cmd}  ${t.gray('· ' + c.for)}`);
      say(`\n  ${t.gray('commit these files, so every agent and colleague gets them')}\n`);
      return;
    }
    if (fs.existsSync(LOCAL_FILE)) return say('  ' + t.warn(`${LOCAL_FILE} already exists`));
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(TEMPLATE, null, 2) + '\n');
    say('  ' + t.ok(`wrote ${LOCAL_FILE}`));
    say(t.gray(`  set app.bundleId, then export SNAPPCRAWL_USERNAME / SNAPPCRAWL_PASSWORD if the app needs a login.`));
    if (fs.existsSync('.gitignore') && !fs.readFileSync('.gitignore', 'utf8').includes('.snappcrawl')) fs.appendFileSync('.gitignore', '\n.snappcrawl/\n');
  },

  async crawl() {
    // --build / --base-ref: build from the Xcode project first (both builds before any crawl,
    // so a build error stops it early); the bundle id comes from the build
    let built = null;
    let baseBuilt = null;
    if (opt.build || opt['base-ref']) {
      const b = { project: opt.project, scheme: opt.scheme, configuration: opt.configuration || 'Debug', settings: [].concat(opt.set || []), log: t.logLine };
      if (opt.then) throw expected('--build crawls one app · with two builds side by side install them, then use --then');
      built = await buildApp(b);
      if (opt['base-ref']) {
        baseBuilt = await buildRef({ ...b, ref: opt['base-ref'] });
        if (baseBuilt.bundleId !== built.bundleId) throw expected(`${opt['base-ref']} builds ${baseBuilt.bundleId}, the working tree ${built.bundleId} · compare them with --then after installing both`);
      }
      cfg.app.bundleId = opt.bundle || built.bundleId;
    }
    cfg.app.bundleId = opt.bundle || cfg.app.bundleId;
    if (!cfg.app.bundleId) throw expected(`no app given · --bundle com.example.app or app.bundleId in ${LOCAL_FILE} (snappcrawl apps lists bundle ids)`);
    // check: the limits of the baseline unless given, so none of its screens is out of reach
    const lim = checking ? baselineLimits(store, opt.against || cfg.app.bundleId) : null;
    if (lim) Object.assign(cfg.crawl, { maxDepth: lim.maxDepth, maxScreens: lim.maxScreens, timeLimitMin: lim.timeLimitMin, maxPerList: lim.maxPerList || 0, ...(lim.scroll ? { scroll: true, maxScrollPages: lim.maxScrollPages } : {}) });
    if (opt['max-depth']) cfg.crawl.maxDepth = Number(opt['max-depth']);
    if (opt['max-screens']) cfg.crawl.maxScreens = Number(opt['max-screens']);
    if (opt.minutes) cfg.crawl.timeLimitMin = Number(opt.minutes);
    if (opt.mfa) cfg.auth.mfa = opt.mfa;
    if (opt.prepare) cfg.crawl.prepare = true;
    if (opt.alerts) cfg.crawl.systemAlerts = opt.alerts;
    if (opt.dismiss) cfg.crawl.dismiss = list(opt.dismiss);
    if (opt.block) cfg.crawl.blocklist = [...cfg.crawl.blocklist, ...list(opt.block)];
    if (opt['no-follow']) cfg.crawl.follow = false;
    if (opt.intro) {
      if (!['keep', 'skip', 'fresh'].includes(opt.intro)) throw expected(`--intro must be keep, skip or fresh, not "${opt.intro}"`);
      cfg.crawl.intro = opt.intro;
    }
    if (opt.reinstall) {
      cfg.crawl.reinstall = path.resolve(opt.reinstall);
      cfg.crawl.intro ||= 'fresh';
    }
    if (opt.prefer) cfg.crawl.prefer = list(opt.prefer);
    if (opt['max-per-list']) cfg.crawl.maxPerList = Number(opt['max-per-list']);
    if (opt.scroll || opt['scroll-pages']) cfg.crawl.scroll = true;
    if (opt['scroll-pages']) cfg.crawl.maxScrollPages = Number(opt['scroll-pages']);
    if (opt.against) cfg.crawl.against = opt.against;
    if (opt.then && opt.against) throw expected('--then crawls the baseline app itself · leave out --against');
    if (opt.then === cfg.app.bundleId) throw expected('--then needs another bundle id than --bundle · to compare one app with itself, crawl it twice');
    if (opt.then && cfg.crawl.reinstall) throw expected('--reinstall installs one build · with --then use --intro fresh, each app is reset before its run');
    if (cfg.crawl.against && !opt.then && !store.baselineFor(cfg.crawl.against)) throw expected(`no baseline for ${cfg.crawl.against} · crawl it first, or both at once: snappcrawl crawl --bundle ${cfg.crawl.against} --then ${cfg.app.bundleId}`);
    const o = driverOpts();
    const driver = makeDriver({ ...o, bundleId: cfg.app.bundleId });
    t.title('crawl', `${opt.then ? `${cfg.app.bundleId} then ${opt.then}` : cfg.app.bundleId} · ${driver.platform === 'ios-device' ? 'iPhone' : 'simulator'} · depth ≤ ${cfg.crawl.maxDepth} · ≤ ${cfg.crawl.maxScreens} screens`);
    if (driver.platform === 'ios-device') await control.ensureWda({ udid: o.udid, url: wdaUrl(), log: t.logLine });
    if (opt.parallel && !opt.then) throw expected('--parallel <simulator> crawls the --then build on a second simulator · it needs --then');
    let second = null;
    if (opt.parallel) {
      try {
        second = await secondSimulator(driver, opt.parallel, opt.then);
      } catch (e) {
        throw expected(e.message);
      }
      say(t.gray(`  1 ${cfg.app.bundleId} on ${driver.name} · 2 ${opt.then} on ${second.name}, at the same time\n`));
    }

    const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : { close() {} };
    let stop = false;
    process.on('SIGINT', () => {
      if (stop) process.exit(130);
      stop = true;
      t.logLine('WARN', 'stopping after the current step · press ctrl-c again to quit');
    });
    // a status line under the log: estimated progress, time left, screens, taps, time
    const count = { screens: 0, edges: 0, progress: null };
    const started = Date.now();
    const tick = () => {
      const p = count.progress;
      const spin = t.SPINNER[Math.floor((Date.now() - started) / 120) % t.SPINNER.length];
      const est = p ? `${t.white(p.pct + '%')} ${t.gray('· ' + formatEta(p.etaMs) + ' left ·')} ` : '';
      t.setStatus(`${t.gray(spin)} ${est}${t.gray(`${count.screens} screens · ${count.edges} transitions${p ? ` · ${p.done}/${p.total} taps` : ''} · ${t.elapsed(Date.now() - started).slice(0, 5)}`)}`);
    };
    const timer = setInterval(tick, 120);
    const io = {
      log: t.logLine,
      event: (type, data) => {
        if (type === 'run') Object.assign(count, { screens: 0, edges: 0, progress: null });
        if (type === 'screen') count.screens++;
        if (type === 'edge') count.edges++;
        if (type === 'progress') count.progress = data;
      },
      ask: async (kind, prompt) => {
        t.setStatus('');
        if (!interactive) throw new Error(`${NEEDS_INPUT}: ${prompt} · without a terminal: SNAPPCRAWL_USERNAME, SNAPPCRAWL_PASSWORD, SNAPPCRAWL_TOTP_SECRET or SNAPPCRAWL_PIN for logins, --alerts dismiss for prompts, leave out --prepare; or run it once in a terminal`);
        const a = (await rl.question(`         ${t.white('→')} ${kind === 'code' ? 'code: ' : 'press enter to continue '}`)).trim();
        return a;
      },
      aborted: () => stop,
    };
    let atlas;
    let pair = null;
    try {
      if (built) {
        if (driver.platform !== 'ios-sim') throw expected('--build installs on a simulator · for an iPhone install the build with Xcode, then crawl');
        await driver.resolve();
        if (baseBuilt) {
          // the other git state first, as the baseline
          await installApp(driver.udid, baseBuilt.app);
          t.logLine('INFO', `installed ${opt['base-ref']} · crawling it as the baseline`);
          const a = await crawl({ driver, cfg: structuredClone(cfg), store, io, label: opt['base-ref'].replace(/[^\w.-]+/g, '-') });
          if (a.meta.status !== 'done') throw expected(`the crawl of ${opt['base-ref']} did not finish · ${a.meta.error || ''}`);
          store.setBaseline(a.meta.id);
          t.logLine('INFO', `baseline of ${cfg.app.bundleId} is now ${a.meta.id} (${opt['base-ref']})`);
        }
        await installApp(driver.udid, built.app);
        t.logLine('INFO', `installed the working tree's build · ${path.basename(built.app)}`);
      }
      if (opt.then) {
        pair = await crawlPair({ driverFor: (bundleId) => (bundleId === cfg.app.bundleId ? driver : second || makeDriver({ ...o, bundleId })), cfg, store, io, base: cfg.app.bundleId, head: opt.then, label: opt.label || '', parallel: !!second });
        atlas = pair.head || pair.base;
      } else atlas = await crawl({ driver, cfg, store, io, label: opt.label || '' });
    } finally {
      clearInterval(timer);
      t.setStatus('');
      rl.close();
    }
    if (atlas.meta.status !== 'done') {
      const needs = String(atlas.meta.error || '').startsWith(NEEDS_INPUT);
      process.exitCode = needs ? EXIT.input : 1;
      if (opt.json) emit({ verdict: needs ? 'input' : 'error', run: atlas.meta.id, error: atlas.meta.error || 'the crawl did not finish' });
      return void process.stderr.write(t.errorBlock(Object.assign(new Error(atlas.meta.error || 'the crawl did not finish'), { expected: true })));
    }
    if (checking) return finishCheck(atlas, pair);
    if (pair) {
      if (!pair.report) return void say(`\n  ${t.gray('stopped before the test app · baseline:')} ${pair.base.meta.id}\n`);
      printReport(pair.report);
      return void say(`\n  ${t.gray('next:')} snappcrawl review · snappcrawl report --full\n`);
    }
    const baseline = store.baselineFor(cfg.crawl.against || atlas.meta.app);
    if (cfg.crawl.against) {
      if (opt.diff) printReport(buildReport({ store, baseId: baseline, headId: atlas.meta.id, cfg }));
    } else if (!baseline && atlas.meta.status === 'done') {
      store.setBaseline(atlas.meta.id);
      say(`\n  ${t.gray('first run of this app → saved as baseline:')} ${atlas.meta.id}`);
    } else if (opt.diff && baseline && baseline !== atlas.meta.id) {
      printReport(buildReport({ store, baseId: baseline, headId: atlas.meta.id, cfg }));
    }
    say(`\n  ${t.gray('next:')} snappcrawl ${opt.diff ? '' : 'diff'}\n`);
  },

  // crawl + compare with the baseline in one go, for agents and CI (see src/summary.js)
  async check() {
    checking = true;
    await commands.crawl();
  },

  // MCP server on stdio: stdout belongs to the protocol, nothing else may be printed there
  async mcp() {
    process.stdout.write = process.stderr.write.bind(process.stderr);
    startMcp({ cfg, store, version: pkg.version, output: { write: stdoutWrite } });
    process.stderr.write(`snappcrawl ${pkg.version} · MCP server on stdio · store ${store.root}\n`);
    await new Promise((resolve) => process.stdin.on('end', resolve)); // until the client closes stdin
    process.exit(0);
  },

  async runs() {
    if (pos[1] === 'rm') {
      if (!pos[2]) throw expected('which run? · snappcrawl runs rm <run> (snappcrawl runs lists them)');
      const r = control.deleteRun(store, pos[2]);
      say('  ' + t.ok(`deleted ${r.id}${r.diffs ? ` and ${r.diffs} comparison${r.diffs === 1 ? '' : 's'}` : ''}${r.wasBaseline ? ' · it was the baseline, the app has none now' : ''}`));
      return;
    }
    t.title('runs', store.root);
    const b = store.readBaselines();
    const runs = store.listRuns();
    if (opt.json) return emit({ store: store.root, runs: runs.map((r) => ({ ...r, baseline: b[r.app] === r.id })) });
    if (!runs.length) return say(t.gray('  no runs yet · snappcrawl crawl or snappcrawl demo\n'));
    t.table(runs.map((r) => [b[r.app] === r.id ? t.white('◆') : ' ', r.id, r.label, r.appName || r.app, `${r.screens} screens`, r.crashes ? t.red(`${r.crashes} crash`) : '', t.gray(r.status)]), { head: ['', 'run', 'label', 'app', 'size', '', 'status'] });
    say(t.gray('\n  ◆ baseline of its app · snappcrawl runs rm <run> deletes one\n'));
  },

  async baseline() {
    if (pos[1]) return say('  ' + t.ok(`baseline for ${store.setBaseline(pos[1])}: ${pos[1]}`));
    const all = Object.entries(store.readBaselines());
    all.length ? t.table(all.map(([app, id]) => [app, id]), { head: ['app', 'baseline'] }) : say(t.gray('  no baseline yet'));
  },

  async diff() {
    const { base, head } = pickRuns(pos[1], pos[2]);
    let report = buildReport({ store, baseId: base, headId: head, cfg });
    if (opt.ai) report = await notes(report);
    if (opt.junit) fs.writeFileSync(opt.junit, junitXml(summarize(report, store), report));
    if (opt.json) {
      const r = summarize(report, store);
      process.exitCode = EXIT[r.verdict];
      return emit(r);
    }
    if (opt.markdown) return void say(summaryMarkdown(summarize(report, store)));
    printReport(report);
    if (report.summary.bad) process.exitCode = 1;
  },

  async notes() {
    const report = await notes(loadReport(pickRuns(pos[1], pos[2])));
    printReport(report);
  },

  async review() {
    const action = pos[2];
    if (['approve', 'reject', 'undo'].includes(action)) {
      const r = loadReport(pickRuns(pos[3], pos[4]));
      const ids = applyReview(r, pos[1], action);
      store.writeReport(r);
      t.title('review', `${r.base.label || r.base.id} → ${r.head.label || r.head.id}`);
      const names = ids.map((id) => r.screens.find((s) => s.id === id).name);
      say('  ' + (ids.length ? t.ok(`${action} · ${ids.length} screen${ids.length === 1 ? '' : 's'}: ${names.join(', ')}`) : t.gray(`nothing to ${action}`)));
      say();
      printState(r);
      say(`\n  ${t.gray('next:')} snappcrawl ${reviewState(r).open ? 'review' : 'report'}\n`);
      return;
    }
    if (['approve', 'reject', 'undo', 'all'].includes(pos[1])) throw expected('usage · snappcrawl review <screen-id|all> <approve|reject|undo>');
    const r = loadReport(pickRuns(pos[1], pos[2]));
    const changes = r.screens.filter(needsReview);
    const open = changes.filter((s) => decisionOf(r, s) === 'open');
    t.title('review', `${r.base.label || r.base.id} → ${r.head.label || r.head.id} · ${open.length} of ${changes.length} changes open`);
    // open changes first, decided ones below so the progress stays visible
    const rows = [...open, ...changes.filter((s) => !open.includes(s))].map((s) => {
      const d = decisionOf(r, s);
      return [s.id, s.name, TONE[s.status](s.reason || STATUS[s.status]), pct(s.ratio), DECISION[d](d)];
    });
    if (rows.length) t.table(rows, { head: ['id', 'screen', 'status', 'Δ px', 'decision'] });
    else say(t.gray('  no changes'));
    say();
    printState(r);
    say(`\n  ${t.gray('decide:')} snappcrawl review <id|all> <approve|reject|undo>\n`);
  },

  async ignore() {
    const app = cfg.app.bundleId;
    if (pos[1] === 'rm') {
      const n = Number(pos[2]);
      if (!Number.isInteger(n)) throw expected('usage · snappcrawl ignore rm <n> · the numbers are in: snappcrawl ignore');
      store.removeIgnore(app, n - 1);
      say('  ' + t.ok(`rule ${n} removed`));
    } else if (pos[1]) {
      let area = null;
      if (opt.area) {
        const v = String(opt.area).split(/[ ,]+/).map(Number);
        if (v.length !== 4) throw expected('--area x,y,w,h in points, e.g. --area 0,120,393,300');
        area = { x: v[0], y: v[1], w: v[2], h: v[3] };
      }
      try {
        store.addIgnore(app, { screen: pos.slice(1).join(' '), area });
      } catch (e) {
        throw expected(e.message);
      }
      say('  ' + t.ok(`${area ? 'area ignored' : 'pixels ignored'} on "${pos.slice(1).join(' ')}" · ${app} · from the next comparison`));
    }
    const rules = store.ignoreFor(app);
    t.title('ignore', `${app} · areas left out of the pixel comparison`);
    if (rules.length) t.table(rules.map((r, i) => [String(i + 1), r.screen, r.area ? `${r.area.x},${r.area.y} · ${r.area.w}×${r.area.h} pt` : 'the whole screen']), { head: ['n', 'screen', 'area'] });
    else say(t.gray('  none · snappcrawl ignore "<screen>" [--area x,y,w,h]'));
    say();
  },

  async report() {
    const r = loadReport(pickRuns(pos[1], pos[2]));
    const type = opt.full ? 'full' : 'summary';
    const out = path.resolve(opt.out || path.join(store.reportsDir, reportFileName(r, type)));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderReport({ store, report: r, type, version: pkg.version }));
    t.title('report', `${type} · ${r.base.label || r.base.id} → ${r.head.label || r.head.id}`);
    say('  ' + t.ok(out) + t.gray(`  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`));
    say();
    printState(r);
    say();
  },

  async demo() {
    const { base, head } = createDemo(store);
    buildReport({ store, baseId: base, headId: head, cfg });
    t.title('demo', 'two sample runs of a fictional app');
    say('  ' + t.ok(`${base} (baseline)`));
    say('  ' + t.ok(head));
    say(`\n  ${t.gray('next:')} snappcrawl\n`);
  },

  async wda() {
    const sub = pos[1] || 'status';
    if (!WDA[sub]) throw expected('usage · snappcrawl wda <setup|start|stop|status>');
    await WDA[sub]();
  },

  async migrate() {
    t.title('migrate');
    const { done, skipped } = legacy.migrate(process.cwd(), { isRunning: () => wdaKit.alive(wdaKit.readPids()?.xcodebuild) });
    for (const d of done) say('  ' + t.ok(d));
    for (const s of skipped) say('  ' + t.warn('left alone: ' + s));
    if (!done.length && !skipped.length) say(t.gray('  nothing to move'));
    say();
  },

  async config() {
    if (pos[1] === 'set' && pos[2]) {
      control.setSetting(pos[2], pos[3] ?? '');
      return say('  ' + t.ok(`${pos[2]} saved to ${GLOBAL_FILE}`));
    }
    say(JSON.stringify(control.settings(), null, 2));
  },
};

async function notes(report) {
  if (!cfg.ai.provider || cfg.ai.provider === 'none') throw expected('no ai provider · snappcrawl config set ai.provider anthropic (or UI: Settings)');
  t.logLine('INFO', `notes via ${cfg.ai.provider}/${cfg.ai.model}`);
  return annotate({ store, report, cfg, onProgress: (n, total, s) => t.logLine('STEP', `${n}/${total} ${s.name}`) });
}

/* ---------- WebDriverAgent ---------- */

const WDA = {
  async setup() {
    t.title('wda setup', wdaKit.WDA_HOME);
    await control.wdaSetup({ team: opt.team, udid: opt.device || opt.udid, bundleId: opt['bundle-id'], log: t.logLine });
    say(`\n  ${t.gray('next:')} snappcrawl wda start  ${t.gray('· or just crawl, it starts by itself')}\n`);
  },

  async start() {
    t.title('wda start', wdaUrl());
    const s = await control.wdaStart({ udid: opt.device || opt.udid, url: wdaUrl(), log: t.logLine });
    say(`\n  ${t.gray('next:')} snappcrawl apps --device "${s.device}"  ${t.gray('· snappcrawl wda stop when done')}\n`);
  },

  async stop() {
    const r = control.wdaStop();
    say('  ' + (r.stopped ? t.ok(`stopped${r.xcodebuild ? ' xcodebuild' : ''}${r.forward ? ' · port forwarding' : ''}`) : t.gray('nothing was running')));
  },

  async status() {
    t.title('wda', wdaUrl());
    const s = await control.wdaState(wdaUrl());
    t.table([
      ['set up', s.built ? `${s.setup.tag} · team ${s.setup.team} · ${s.setup.bundleId} · for ${s.setup.device}` : t.yellow('no · snappcrawl wda setup')],
      ['running', s.running ? t.green(`yes · ${s.device}`) : t.gray('no')],
      ['reachable', s.reachable ? t.green(`yes · WebDriverAgent ${s.version}`) : t.gray('no · snappcrawl wda start')],
      ['ui control', s.control ? t.green('yes') : s.notAuthorized ? t.red('no · iPhone was locked · snappcrawl wda stop && snappcrawl wda start') : t.gray('–')],
    ]);
    say();
  },

  // internal: the port forwarder that `wda start` runs in the background
  async forward() {
    const port = Number(opt.port || 8100);
    const udid = opt.device || opt.udid || '';
    await startForwarder({ udid, localPort: port, devicePort: 8100, onError: (e) => console.error(new Date().toISOString(), e.message) });
    console.log(`${new Date().toISOString()} forwarding 127.0.0.1:${port} → ${udid || 'iPhone'}:8100`);
  },
};

// Files from the previous name still work; say once how to move them.
if (!opt.version && !opt.help && !['help', 'migrate', 'wda', 'mcp'].includes(cmd) && !opt.json) {
  const found = legacy.hintOnce(legacy.legacyInUse());
  if (found) {
    say(t.gray(`\n  still reading files from before the rename: ${found.map((f) => f.from).join(', ')}`));
    say(t.gray(`  move them with: snappcrawl migrate${found.some((f) => f.env) ? '  ·  rename the environment variables to SNAPPCRAWL_*' : ''}`));
  }
}

try {
  if (opt.version) say(pkg.version);
  else if (opt.help) say(HELP);
  else if (!commands[cmd]) {
    process.exitCode = 1;
    throw expected(`unknown command "${cmd}" · snappcrawl help lists all commands`);
  } else await commands[cmd]();
} catch (e) {
  t.setStatus('');
  if (opt.json) emit({ verdict: 'error', error: e.message });
  process.stderr.write(t.errorBlock(e, { debug: opt.debug }));
  process.exitCode = opt.json || checking ? EXIT.setup : 1;
}
