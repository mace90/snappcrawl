import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { baselineLimits, checkResult, thumbnail } from './check.js';
import * as control from './control.js';
import { crawl } from './crawler.js';
import { buildReport } from './diff.js';
import { runChecks } from './doctor.js';
import { listAllDevices, makeDriver } from './drivers/index.js';
import { DEFAULT_WDA_URL } from './drivers/ios-device.js';
import { buildApp, buildRef, installApp } from './build.js';
import { crawlPair } from './pair.js';
import { applyReview } from './report.js';
import { summarize, summaryMarkdown } from './summary.js';

const exec = promisify(execFile);

// snappcrawl as an MCP server (Model Context Protocol, JSON-RPC 2.0 over stdio, one message per
// line), for coding agents: Claude Code, Codex, Copilot, Cursor, Windsurf … No SDK needed.
// A crawl takes minutes and some clients end a tool call after 60 s: `check` waits up to `wait`
// seconds, then answers with the progress and a job id; `check_status` waits for more.

export const INSTRUCTIONS = `snappcrawl crawls an iOS app in the Simulator (or on an iPhone), maps every screen and compares each one with a baseline run: screenshots pixel by pixel, texts, buttons (renamed, moved, removed), navigation, crashes.

Use it whenever you changed an iOS app's UI, navigation, texts, layout or anything that can crash a screen, before you say the work is done:
1. status: is the setup ready, which simulator is booted, which apps have a baseline.
2. check with build: true (it builds the Xcode project for the Simulator and installs it), or with baseRef: "main" to build and crawl main first as the baseline and compare your working tree with it: the easiest way when there is no baseline yet. Or build yourself and pass appPath / bundleId.
3. Without baseRef, the first check of an app saves the baseline: make it from the code before your change.
4. Read the verdict: passed, changes (review them), broken (crash or unreachable screen: almost always a bug you made). For each changed screen read texts and buttons; look at it with screen (head and diff images) when the words are not enough.
5. Fix bugs and check again. Changes you intended: review approve. When the new state should be the reference: set_baseline.
Never approve a crash or an unreachable screen you cannot explain. An area that changes on every run (animation, live data) can be ignored with ignore.`;

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

export const TOOLS = [
  {
    name: 'status',
    title: 'Setup, devices, apps with a baseline',
    description: 'Is snappcrawl ready (Xcode, idb, a booted simulator, an iPhone)? The config, the baselines per app and the latest runs. Call it first.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_apps',
    title: 'Installed apps',
    description: 'Apps installed on the simulator (or an iPhone), with their bundle ids and whether they have a baseline.',
    inputSchema: { type: 'object', properties: { udid: str('simulator udid or name; default: the booted one'), device: str('iPhone udid or name instead of a simulator') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'install_app',
    title: 'Install a build on the simulator',
    description: 'Install a .app built for the simulator (e.g. from xcodebuild -sdk iphonesimulator, in DerivedData/…/Build/Products/Debug-iphonesimulator/). Returns its bundle id.',
    inputSchema: { type: 'object', properties: { appPath: str('path to the .app'), udid: str('simulator; default: the booted one') }, required: ['appPath'] },
  },
  {
    name: 'check',
    title: 'Crawl the app and compare with the baseline',
    description: 'Crawls the app (taps through every screen, follows the baseline) and compares every screen with the baseline: verdict passed | changes | broken | baseline (first run) | input (a login or PIN is missing) | error. Answers within `wait` seconds; if the crawl is still running, call check_status with the job id.',
    inputSchema: {
      type: 'object',
      properties: {
        bundleId: str('the app; default: app.bundleId of snappcrawl.config.json'),
        appPath: str('install this .app first (simulator)'),
        build: { type: 'boolean', description: 'build the app from its Xcode project for the Simulator first, install it (bundleId comes from the build)' },
        baseRef: str('a git ref (e.g. main): built in a temporary worktree and crawled first as the baseline, so your working tree is compared with it. Implies build'),
        dir: str('folder with the Xcode project (default: where the MCP server runs)'),
        project: str('.xcodeproj or .xcworkspace, if the folder has several'),
        scheme: str('scheme to build'),
        buildSettings: { type: 'array', items: { type: 'string' }, description: 'extra build settings, KEY=VALUE' },
        udid: str('simulator udid or name; default: the booted one'),
        device: str('crawl on this iPhone (USB) instead of a simulator'),
        label: str('a name for the run, e.g. the branch or "after-fix"'),
        maxScreens: num('stop after this many screens (default: as in the baseline, else 40)'),
        maxDepth: num('taps away from the start screen (default: as in the baseline, else 4)'),
        minutes: num('time limit (default: as in the baseline, else 10)'),
        then: str('a second build installed side by side: bundleId becomes the baseline, this one is compared with it'),
        intro: { type: 'string', enum: ['keep', 'skip', 'fresh'], description: 'screens shown only on the first start' },
        scroll: { type: 'boolean', description: 'scroll long screens page by page: tap what is below the fold, compare the whole page (slower; default: as in the baseline)' },
        wait: num('seconds to wait for the result before answering with the progress (default 45)'),
      },
    },
  },
  {
    name: 'check_status',
    title: 'Wait for a running check',
    description: 'The result of a check, or its progress and log while it runs. Waits up to `wait` seconds (default 45).',
    inputSchema: { type: 'object', properties: { job: str('the job id from check'), wait: num('seconds to wait (default 45)') }, required: ['job'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'stop',
    title: 'Stop a running check',
    description: 'Stops the crawl after the current step.',
    inputSchema: { type: 'object', properties: { job: str('the job id') }, required: ['job'] },
  },
  {
    name: 'compare',
    title: 'Compare two runs',
    description: 'The comparison of two runs, by default the baseline and the newest run after it. Same result as check.',
    inputSchema: { type: 'object', properties: { base: str('run id of the reference'), head: str('run id to check') } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'screen',
    title: 'One screen: texts, buttons, pictures',
    description: 'Everything about one screen of a comparison: path to it, status, changed texts and buttons, and the pictures (head, base, diff in red) as images.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('screen id from the comparison, e.g. s004'),
        base: str('run id; default: as in compare'),
        head: str('run id; default: as in compare'),
        images: { type: 'array', items: { type: 'string', enum: ['head', 'base', 'diff'] }, description: 'which pictures (default: head and diff, or head for a new screen)' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'review',
    title: 'Approve or reject changes',
    description: 'Decide on changed, new or broken screens like a reviewer: approve (intended), reject (a bug), undo. "all" means every open change.',
    inputSchema: {
      type: 'object',
      properties: { screens: { description: 'a screen id, a list of ids, or "all"', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, decision: { type: 'string', enum: ['approve', 'reject', 'undo'] }, base: str('run id'), head: str('run id') },
      required: ['screens', 'decision'],
    },
  },
  {
    name: 'set_baseline',
    title: 'Make a run the reference',
    description: 'From now on, checks of this app compare with this run.',
    inputSchema: { type: 'object', properties: { run: str('run id') }, required: ['run'] },
  },
  {
    name: 'ignore',
    title: 'Leave an area out of the pixel comparison',
    description: 'For something that changes on every run (an animation, a live chart, a random tip). Per app and screen name; area in points. Without area: the whole screen\'s pixels. remove: the number of a rule to drop. Without screen and remove: lists the rules.',
    inputSchema: {
      type: 'object',
      properties: {
        bundleId: str('the app; default: from the config'),
        screen: str('screen name as in the comparison'),
        area: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, description: 'in points' },
        remove: num('rule number (1-based) to remove'),
      },
    },
  },
];

export function startMcp({ cfg, store, version = '', input = process.stdin, output = process.stdout, driverFactory = makeDriver }) {
  const jobs = new Map();
  let jobNo = 0;
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });
  const result = (r) => text(`${r.screens && r.verdict !== 'baseline' ? summaryMarkdown(r) + '\n\n' : ''}${JSON.stringify(r, null, 1)}`, { structuredContent: r });
  const fail = (message) => text(message, { isError: true });
  const wdaUrl = () => cfg.device.wdaUrl || DEFAULT_WDA_URL;

  const pickPair = (base, head) => {
    if (head) return { base: base || store.baselineFor(store.readRun(head).meta.app), head };
    const p = store.defaultPair();
    if (p.error) throw new Error(p.error);
    return { base: base || p.base, head: p.head };
  };
  const reportOf = (base, head) => {
    const p = pickPair(base, head);
    return store.readReport(p.base, p.head) || buildReport({ store, baseId: p.base, headId: p.head, cfg });
  };

  function startCheck(a) {
    const run = structuredClone(cfg);
    if (a.bundleId) run.app.bundleId = a.bundleId;
    const building = a.build || a.baseRef;
    if (building && a.then) throw new Error('build crawls one app · with two builds side by side install both, then use then');
    if (!run.app.bundleId && !building) throw new Error('which app? · pass bundleId (list_apps shows them) or set app.bundleId in snappcrawl.config.json');
    // like the baseline, so its screens are all within reach; else a quick first map
    const lim = baselineLimits(store, a.then ? run.app.bundleId : run.crawl.against || run.app.bundleId) || {};
    Object.assign(run.crawl, { maxScreens: a.maxScreens || lim.maxScreens || 40, maxDepth: a.maxDepth || lim.maxDepth || 4, timeLimitMin: a.minutes || lim.timeLimitMin || 10, maxPerList: lim.maxPerList || 0, scroll: a.scroll ?? !!lim.scroll, maxScrollPages: lim.maxScrollPages || 5 });
    if (lim.prefer?.length) run.crawl.prefer = lim.prefer;
    if (a.intro) run.crawl.intro = a.intro;
    if ([...jobs.values()].some((j) => j.running)) throw new Error('a check is already running · check_status or stop it first');
    const platform = a.device ? 'ios-device' : 'ios-sim';
    const udid = a.device || a.udid || (cfg.device.platform === platform ? cfg.device.udid : '');
    const id = `job${++jobNo}`;
    const job = { id, app: run.app.bundleId || '(from the build)', running: true, started: Date.now(), log: [], progress: null, screens: 0, result: null, abort: false };
    jobs.set(id, job);
    const io = {
      log: (lvl, msg) => {
        job.log.push(`${lvl} ${msg}`);
        if (job.log.length > 400) job.log.splice(0, 100);
      },
      event: (type, data) => {
        if (type === 'screen') job.screens++;
        if (type === 'progress') job.progress = data;
      },
      ask: async (kind, prompt) => {
        throw new Error(`needs a person: ${prompt} · set the login in snappcrawl.config.json or SNAPPCRAWL_USERNAME, SNAPPCRAWL_PASSWORD, SNAPPCRAWL_TOTP_SECRET, SNAPPCRAWL_PIN for the MCP server, or ask the user to run snappcrawl crawl once in a terminal`);
      },
      aborted: () => job.abort,
    };
    job.done = (async () => {
      try {
        let built = null;
        let baseBuilt = null;
        if (building) {
          if (platform !== 'ios-sim') throw new Error('build installs on a simulator · on an iPhone install the build with Xcode');
          const b = { dir: path.resolve(a.dir || process.cwd()), project: a.project, scheme: a.scheme, settings: a.buildSettings || [], log: io.log };
          built = await buildApp(b);
          if (a.baseRef) {
            baseBuilt = await buildRef({ ...b, ref: a.baseRef });
            if (baseBuilt.bundleId !== built.bundleId) throw new Error(`${a.baseRef} builds ${baseBuilt.bundleId}, the working tree ${built.bundleId}`);
          }
          run.app.bundleId = a.bundleId || built.bundleId;
          job.app = run.app.bundleId;
          const lim = baselineLimits(store, run.app.bundleId) || {};
          Object.assign(run.crawl, { maxScreens: a.maxScreens || lim.maxScreens || 40, maxDepth: a.maxDepth || lim.maxDepth || 4, timeLimitMin: a.minutes || lim.timeLimitMin || 10, scroll: a.scroll ?? !!lim.scroll, maxScrollPages: lim.maxScrollPages || 5 });
        }
        if (a.appPath) {
          if (platform !== 'ios-sim') throw new Error('appPath installs on a simulator · on an iPhone install it with Xcode');
          await install(a.appPath, udid);
        }
        const driver = driverFactory({ platform, udid, bundleId: run.app.bundleId, wdaUrl: wdaUrl() });
        if (platform === 'ios-device') await control.ensureWda({ udid, url: wdaUrl(), log: io.log });
        if (built) {
          await driver.resolve();
          if (baseBuilt) {
            await installApp(driver.udid, baseBuilt.app);
            io.log('INFO', `installed ${a.baseRef} · crawling it as the baseline`);
            const base = await crawl({ driver, cfg: structuredClone(run), store, io, label: a.baseRef.replace(/[^\w.-]+/g, '-') });
            if (base.meta.status !== 'done') throw new Error(`the crawl of ${a.baseRef} did not finish · ${base.meta.error || ''}`);
            store.setBaseline(base.meta.id);
          }
          await installApp(driver.udid, built.app);
        }
        let atlas;
        let pair = null;
        if (a.then) {
          pair = await crawlPair({ driverFor: (b) => (b === run.app.bundleId ? driver : driverFactory({ platform, udid, bundleId: b, wdaUrl: wdaUrl() })), cfg: run, store, io, base: run.app.bundleId, head: a.then, label: a.label || 'agent' });
          atlas = pair.head || pair.base;
        } else atlas = await crawl({ driver, cfg: run, store, io, label: a.label || 'agent' });
        job.result = checkResult({ atlas, pair, store, cfg: run });
      } catch (e) {
        job.result = { verdict: 'error', app: run.app.bundleId, error: e.message };
      } finally {
        job.running = false;
      }
    })();
    return job;
  }

  async function install(appPath, udid) {
    const app = path.resolve(appPath);
    if (!fs.existsSync(app)) throw new Error(`${app} not found · the .app from xcodebuild -sdk iphonesimulator (Build/Products/Debug-iphonesimulator)`);
    const d = await driverFactory({ platform: 'ios-sim', udid }).resolve();
    await exec('xcrun', ['simctl', 'install', d.udid, app]);
    let bundleId = '';
    try {
      bundleId = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Info.plist')])).stdout.trim();
    } catch {}
    return { installed: app, simulator: d.name, udid: d.udid, bundleId };
  }

  // wait for a job up to `wait` seconds, sending progress to the client meanwhile
  async function waitFor(job, wait = 45, progressToken) {
    const until = Date.now() + Math.max(1, Math.min(wait, 600)) * 1000;
    let last = -1;
    while (job.running && Date.now() < until) {
      await Promise.race([job.done, new Promise((r) => setTimeout(r, 1000))]);
      if (progressToken != null && job.progress && job.progress.done !== last) {
        last = job.progress.done;
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: job.progress.done, total: job.progress.total, message: `${job.screens} screens · ${job.progress.pct} %` } });
      }
    }
    if (!job.running) return result(job.result);
    const p = job.progress;
    return text(JSON.stringify({ verdict: 'running', job: job.id, app: job.app, screens: job.screens, progress: p ? `${p.pct} % · about ${Math.round(p.etaMs / 1000)} s left` : 'starting', recent: job.log.slice(-8), next: `call check_status with job "${job.id}" to wait for the result` }, null, 1));
  }

  const handlers = {
    async status() {
      const [checks, devices] = await Promise.all([runChecks({ cfg }).catch(() => []), listAllDevices().catch(() => ({ sims: [], devices: [] }))]);
      const runs = store.listRuns().slice(0, 8).map((r) => ({ run: r.id, app: r.app, label: r.label, status: r.status, screens: r.screens, crashes: r.crashes }));
      return text(JSON.stringify({
        version,
        ready: !checks.some((c) => c.state === 'fail'),
        setup: checks.filter((c) => c.state !== 'ok').map((c) => ({ check: c.label, state: c.state, value: c.value, fix: c.fix?.cmd || c.fix?.steps?.join(' ') })),
        bootedSimulators: devices.sims.filter((s) => s.state === 'Booted').map((s) => ({ name: s.name, udid: s.udid, runtime: s.runtime })),
        iphones: devices.devices.map((d) => ({ name: d.name, udid: d.udid })),
        configuredApp: cfg.app.bundleId || null,
        baselines: store.readBaselines(),
        latestRuns: runs,
        store: store.root,
        running: [...jobs.values()].filter((j) => j.running).map((j) => j.id),
      }, null, 1));
    },
    async list_apps(a) {
      const d = driverFactory({ platform: a.device ? 'ios-device' : 'ios-sim', udid: a.device || a.udid || '', wdaUrl: wdaUrl() });
      await (d.findDevice ? d.findDevice() : d.resolve());
      const apps = await d.listApps();
      return text(JSON.stringify({ device: d.name, apps: apps.map((x) => ({ ...x, baseline: store.baselineFor(x.bundleId) })) }, null, 1));
    },
    async install_app(a) {
      return text(JSON.stringify(await install(a.appPath, a.udid || ''), null, 1));
    },
    async check(a, meta) {
      return waitFor(startCheck(a), a.wait ?? 45, meta?.progressToken);
    },
    async check_status(a, meta) {
      const job = jobs.get(a.job);
      if (!job) return fail(`no job "${a.job}" · jobs live as long as the MCP server`);
      return waitFor(job, a.wait ?? 45, meta?.progressToken);
    },
    async stop(a) {
      const job = jobs.get(a.job);
      if (!job) return fail(`no job "${a.job}"`);
      job.abort = true;
      return text(`stopping ${job.id} after the current step`);
    },
    async compare(a) {
      return result(summarize(reportOf(a.base, a.head), store));
    },
    async screen(a) {
      const report = reportOf(a.base, a.head);
      const s = report.screens.find((x) => x.id === a.id);
      if (!s) return fail(`no screen ${a.id} in ${report.base.id} → ${report.head.id} · compare lists them`);
      const r = summarize(report, store).screens.find((x) => x.id === a.id) || { id: s.id, name: s.name, status: s.status, path: ['start', ...s.path] };
      const head = store.readRun(report.head.id).screens.find((x) => x.id === s.id);
      const want = a.images || (s.diffImg ? ['head', 'diff'] : s.headImg ? ['head'] : ['base']);
      const content = [{ type: 'text', text: JSON.stringify({ ...r, texts: r.texts, allTexts: head?.texts, actions: head?.actions?.map((x) => x.label || x.type) }, null, 1) }];
      for (const k of want) {
        const rel = { head: s.headImg, base: s.baseImg, diff: s.diffImg }[k];
        if (!rel) continue;
        content.push({ type: 'text', text: `${k}: ${path.join(store.root, rel)}` });
        content.push({ type: 'image', data: thumbnail(path.join(store.root, rel)).toString('base64'), mimeType: 'image/png' });
      }
      return { content };
    },
    async review(a) {
      const report = reportOf(a.base, a.head);
      const target = Array.isArray(a.screens) ? a.screens : [a.screens];
      const ids = target.flatMap((t) => applyReview(report, t, a.decision));
      store.writeReport(report);
      const r = summarize(report, store);
      return text(`${a.decision} · ${ids.length} screen${ids.length === 1 ? '' : 's'}: ${ids.join(', ') || 'none'} · verdict now ${r.verdict} (${r.review.open} open)`);
    },
    async set_baseline(a) {
      const app = store.setBaseline(a.run);
      return text(`baseline of ${app} is now ${a.run}`);
    },
    async ignore(a) {
      const app = a.bundleId || cfg.app.bundleId;
      if (!app) return fail('which app? · pass bundleId');
      if (a.remove) store.removeIgnore(app, a.remove - 1);
      else if (a.screen) store.addIgnore(app, { screen: a.screen, area: a.area || null });
      return text(JSON.stringify({ app, rules: store.ignoreFor(app).map((r, i) => ({ n: i + 1, ...r })), note: 'applies from the next compare or check' }, null, 1));
    },
  };

  async function handle(msg) {
    const { id, method, params = {} } = msg;
    const reply = (res) => id !== undefined && send({ jsonrpc: '2.0', id, result: res });
    const error = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'snappcrawl', title: 'snappcrawl · iOS app crawler and visual regression check', version }, instructions: INSTRUCTIONS });
      }
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({ tools: TOOLS });
      if (method === 'tools/call') {
        const h = handlers[params.name];
        if (!h) return error(-32602, `unknown tool ${params.name}`);
        try {
          return reply(await h(params.arguments || {}, params._meta));
        } catch (e) {
          return reply(fail(e.message));
        }
      }
      if (method?.startsWith('notifications/')) return;
      return error(-32601, `method not found: ${method}`);
    } catch (e) {
      return error(-32603, e.message);
    }
  }

  const rl = readline.createInterface({ input });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  });
  return { jobs, close: () => rl.close() };
}
