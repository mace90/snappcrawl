import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotate, aiReady } from './ai.js';
import { loadConfig } from './config.js';
import * as control from './control.js';
import { crawl } from './crawler.js';
import { crawlPair, secondSimulator } from './pair.js';
import { buildReport } from './diff.js';
import { runChecks } from './doctor.js';
import { makeDriver } from './drivers/index.js';
import { DEFAULT_WDA_URL, listDevices } from './drivers/ios-device.js';
import { hasBinary, listSimulators } from './drivers/ios-sim.js';
import { REPORT_TYPES, renderReport, reportFileName, setDecision } from './report.js';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const MIME = { '.png': 'image/png', '.json': 'application/json', '.html': 'text/html; charset=utf-8' };

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * The API behind the web UI. Every action here calls the same functions as the CLI
 * (see src/actions.js for the list). Exported so the routes can be checked without a server.
 */
export function createRoutes({ store, cfg, version, driverFactory = makeDriver, broadcast = () => {} }) {
  const live = { running: false, runId: null, ask: null, log: [], abort: false };
  // one long WebDriverAgent job at a time (setup or start), streamed as "job" events
  const job = { kind: null, running: false, log: [], ok: null, error: null, hints: [] };
  const wdaUrl = () => cfg.device.wdaUrl || DEFAULT_WDA_URL;

  const io = {
    log(level, msg) {
      const line = { t: Date.now(), level, msg };
      live.log.push(line);
      if (live.log.length > 2000) live.log.shift();
      broadcast('log', line);
    },
    event(type, data) {
      if (type === 'run') live.runId = data.id;
      broadcast(type, data);
    },
    ask(kind, prompt) {
      return new Promise((resolve) => {
        live.ask = { kind, prompt, resolve };
      });
    },
    aborted: () => live.abort,
  };

  async function devices() {
    const tools = { xcrun: await hasBinary('xcrun'), idb: await hasBinary('idb') };
    let sims = [];
    let error = null;
    if (tools.xcrun) {
      try {
        sims = await listSimulators();
      } catch (e) {
        error = e.message;
      }
    } else error = 'xcrun not found: snappcrawl needs macOS with Xcode.';
    // real iPhones: connection, lock, Developer Mode, and the state of WebDriverAgent
    const phones = tools.xcrun ? await listDevices().catch(() => []) : [];
    const usb = await Promise.all(phones.map((d) => control.iphoneStatus(d, { wdaUrl: wdaUrl() })));
    const wda = usb[0]?.wda || (await control.wdaState(wdaUrl()));
    return { tools, sims, usb, wda: { ...wda, setup: undefined, built: wda.built, team: wda.setup?.team || '' }, error };
  }

  function startJob(kind, fn) {
    if (job.running) throw bad(`WebDriverAgent is busy (${job.kind})`, 409);
    Object.assign(job, { kind, running: true, log: [], ok: null, error: null, hints: [] });
    const log = (level, msg) => {
      const line = { t: Date.now(), level, msg };
      job.log.push(line);
      broadcast('job', { kind, ...line });
    };
    fn(log)
      .then(() => (job.ok = true))
      .catch((e) => Object.assign(job, { ok: false, error: e.message, hints: e.hints || [] }))
      .finally(() => {
        job.running = false;
        broadcast('job-done', { kind, ok: job.ok, error: job.error, hints: job.hints });
      });
    return { started: true, kind };
  }

  const routes = {
    'GET /api/state': () => ({
      version,
      runs: store.listRuns(),
      baselines: store.readBaselines(),
      pair: store.defaultPair(),
      live: { running: live.running, runId: live.runId, ask: live.ask && { kind: live.ask.kind, prompt: live.ask.prompt } },
      config: {
        bundleId: cfg.app.bundleId,
        username: cfg.auth.username,
        hasPassword: !!cfg.auth.password,
        mfa: cfg.auth.mfa,
        hasTotp: !!cfg.auth.totpSecret,
        hasPin: !!cfg.auth.pin,
        fallbackManual: cfg.auth.fallbackManual,
        crawl: { maxDepth: cfg.crawl.maxDepth, maxScreens: cfg.crawl.maxScreens, timeLimitMin: cfg.crawl.timeLimitMin, blocklist: cfg.crawl.blocklist, prepare: !!cfg.crawl.prepare, systemAlerts: cfg.crawl.systemAlerts, dismiss: cfg.crawl.dismiss, prefer: cfg.crawl.prefer || [], maxPerList: cfg.crawl.maxPerList || 0, scroll: !!cfg.crawl.scroll, maxScrollPages: cfg.crawl.maxScrollPages || 5, follow: cfg.crawl.follow !== false, intro: cfg.crawl.intro || '', reinstall: cfg.crawl.reinstall || '' },
        ai: { provider: cfg.ai.provider, model: cfg.ai.model, ready: aiReady(cfg.ai) },
        file: cfg._file,
      },
    }),
    'GET /api/devices': devices,
    'GET /api/doctor': async () => ({ checks: await runChecks({ cfg }) }),
    'POST /api/boot': async (q, body) => ({ sim: await control.bootSimulator(body.udid || body.name) }),
    'GET /api/wda/status': () => control.wdaState(wdaUrl()),
    'GET /api/wda/teams': async () => ({ teams: await control.teams() }),
    'GET /api/job': () => job,
    'POST /api/wda/setup': (q, body) => startJob('setup', (log) => control.wdaSetup({ team: body.team || undefined, udid: body.udid, bundleId: body.bundleId || undefined, log })),
    'POST /api/wda/start': (q, body) => startJob('start', (log) => control.wdaStart({ udid: body.udid, url: wdaUrl(), log })),
    'POST /api/wda/stop': () => control.wdaStop(),
    'GET /api/runs': () => ({ runs: store.listRuns(), baselines: store.readBaselines() }),
    'POST /api/runs/delete': (q, body) => {
      if (live.running && live.runId === body.id) throw bad('this run is still crawling · stop it first', 409);
      return control.deleteRun(store, body.id);
    },
    'GET /api/config': () => ({ settings: control.settings(), ai: { provider: cfg.ai.provider, model: cfg.ai.model, ready: aiReady(cfg.ai) } }),
    'POST /api/config': (q, body) => {
      const settings = control.setSetting(String(body.key || ''), body.value ?? '');
      Object.assign(cfg.ai, loadConfig().ai); // take effect without a restart
      return { settings, ai: { provider: cfg.ai.provider, model: cfg.ai.model, ready: aiReady(cfg.ai) } };
    },
    'GET /api/apps': async (q) => {
      const d = makeDriver({ platform: q.get('type') === 'device' ? 'ios-device' : 'ios-sim', udid: q.get('udid') || '', wdaUrl: cfg.device.wdaUrl });
      await (d.findDevice ? d.findDevice() : d.resolve());
      return { apps: await d.listApps() };
    },
    'GET /api/run': (q) => store.readRun(q.get('id')),
    'GET /api/log': () => ({ log: live.log }),
    'GET /api/report': (q) => {
      const base = q.get('base');
      const head = q.get('head');
      if (!base || !head) throw Object.assign(new Error('base and head are required'), { status: 400 });
      return (q.get('fresh') ? null : store.readReport(base, head)) || buildReport({ store, baseId: base, headId: head, cfg });
    },
    'POST /api/review': (q, body) => {
      const report = store.readReport(body.base, body.head);
      if (!report) throw Object.assign(new Error('report not found'), { status: 404 });
      setDecision(report, [].concat(body.screen), body.decision);
      store.writeReport(report);
      return { review: report.review };
    },
    'GET /api/ignore': (q) => ({ rules: store.ignoreFor(q.get('app') || cfg.app.bundleId) }),
    'POST /api/ignore': (q, body) => {
      try {
        return { rules: store.addIgnore(String(body.app || ''), { screen: body.screen, area: body.area || null }) };
      } catch (e) {
        throw bad(e.message);
      }
    },
    'POST /api/ignore/remove': (q, body) => {
      try {
        return { rules: store.removeIgnore(String(body.app || ''), Number(body.index)) };
      } catch (e) {
        throw bad(e.message);
      }
    },
    'POST /api/baseline': (q, body) => {
      store.setBaseline(body.run);
      return { baselines: store.readBaselines() };
    },
    'POST /api/notes': async (q, body) => {
      const report = store.readReport(body.base, body.head);
      if (!report) throw Object.assign(new Error('report not found'), { status: 404 });
      return annotate({ store, report, cfg, onProgress: (n, total) => broadcast('notes', { n, total }) });
    },
    'POST /api/crawl': (q, body) => {
      if (live.running) throw Object.assign(new Error('A crawl is already running'), { status: 409 });
      const run = structuredClone(cfg);
      run.app.bundleId = body.bundleId || run.app.bundleId;
      if (!run.app.bundleId) throw Object.assign(new Error('Pick an app (bundle id) first'), { status: 400 });
      Object.assign(run.auth, Object.fromEntries(Object.entries(body.auth || {}).filter(([, v]) => v !== '' && v !== undefined)));
      Object.assign(run.crawl, Object.fromEntries(Object.entries(body.crawl || {}).filter(([, v]) => v !== '' && v !== undefined)));
      const then = String(body.then || '').trim();
      if (then && then === run.app.bundleId) throw bad('the test app needs another bundle id than the baseline app · to compare one app with itself, crawl it twice');
      if (then && run.crawl.reinstall) throw bad('reinstall installs one build · with two apps use intro fresh, each app is reset before its run');
      if (!then && run.crawl.against && !store.baselineFor(run.crawl.against)) throw bad(`no baseline for ${run.crawl.against} · crawl it first`);
      const platform = body.platform || run.device.platform;
      const udid = body.udid || (platform === run.device.platform ? run.device.udid : '');
      const driverFor = (bundleId) => driverFactory({ platform, udid, bundleId, wdaUrl: run.device.wdaUrl });
      const parallel = then ? String(body.parallel || '').trim() : '';
      if (parallel && platform !== 'ios-sim') throw bad('parallel crawls need simulators · on an iPhone the two builds run one after the other');
      // one driver for the baseline app, so a second simulator never takes its place
      Object.assign(live, { running: true, runId: null, ask: null, log: [], abort: false });
      // on an iPhone, WebDriverAgent is started first when it is not running
      (platform === 'ios-device' && !body.noWdaStart ? control.ensureWda({ udid, url: run.device.wdaUrl || DEFAULT_WDA_URL, log: io.log }) : Promise.resolve())
        .then(async () => {
          const first = driverFor(run.app.bundleId);
          if (!then) return crawl({ driver: first, cfg: run, store, io, label: body.label || '' });
          const second = parallel ? await secondSimulator(first, parallel, then) : null;
          const p = await crawlPair({ driverFor: (b) => (b === run.app.bundleId ? first : second || driverFor(b)), cfg: run, store, io, base: run.app.bundleId, head: then, label: body.label || '', parallel: !!second });
          return p.head || p.base;
        })
        .then((atlas) => {
          if (!then && !run.crawl.against && atlas.meta.status === 'done' && !store.baselineFor(atlas.meta.app)) {
            store.setBaseline(atlas.meta.id);
            io.log('INFO', `first run of ${atlas.meta.appName || atlas.meta.app} · saved as baseline`);
          }
        })
        .catch((e) => {
          io.log('ERROR', e.message);
          for (const h of e.hints || []) io.log('WAIT', h);
        })
        .finally(() => {
          live.running = false;
          live.ask = null;
          broadcast('state', { running: false });
        });
      return { started: true, baseline: store.baselineFor(run.app.bundleId) };
    },
    'POST /api/answer': (q, body) => {
      if (!live.ask) return { ok: false };
      const { resolve } = live.ask;
      live.ask = null;
      resolve(body.value ?? '');
      broadcast('answered', {});
      return { ok: true };
    },
    'POST /api/stop': () => {
      live.abort = true;
      return { ok: true };
    },
    'GET /api/export': (q) => {
      const base = q.get('base');
      const head = q.get('head');
      const type = q.get('type') || 'summary';
      if (!base || !head) throw bad('base and head are required');
      if (!REPORT_TYPES.includes(type)) throw bad('type must be summary or full');
      const report = store.readReport(base, head) || buildReport({ store, baseId: base, headId: head, cfg });
      return { raw: renderReport({ store, report, type, version }), type: MIME['.html'], headers: { 'content-disposition': `attachment; filename="${reportFileName(report, type)}"` } };
    },
  };
  return { routes, live, job };
}

export function startServer({ store, cfg, port = 4747, version, driverFactory = makeDriver }) {
  const clients = new Set();
  const broadcast = (type, data) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  const { routes } = createRoutes({ store, cfg, version, driverFactory, broadcast });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(UI), MIME['.html']);
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith('/files/')) {
        const rel = decodeURIComponent(url.pathname.slice(7));
        const file = path.resolve(store.root, rel);
        if (!file.startsWith(store.root + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'not found' });
      const body = req.method === 'POST' ? await readBody(req) : null;
      const out = await handler(url.searchParams, body);
      if (out?.raw !== undefined) {
        res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-store', ...out.headers });
        return res.end(out.raw);
      }
      send(res, 200, out);
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });

  // Take the next free port if the requested one is busy (e.g. another snappcrawl ui).
  return new Promise((resolve, reject) => {
    let p = port;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && p < port + 20) server.listen(++p, '127.0.0.1');
      else reject(e);
    });
    server.on('listening', () => resolve({ server, port: p }));
    server.listen(p, '127.0.0.1');
  });
}
