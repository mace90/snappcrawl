import fs from 'node:fs';
import http2 from 'node:http2';
import net from 'node:net';

// A direct line to idb_companion, without the idb command line tool.
// Every `idb ui …` call starts the Python client again (about 0.3 s each, a crawl makes hundreds).
// The companion itself speaks gRPC over HTTP/2 on a local socket, which Node can talk to with
// its own http2 module. Only the few messages the crawler needs are encoded by hand below
// (proto3 wire format, see idb.proto in fb-idb): read the screen, tap, screenshot.
// Anything unexpected → the caller falls back to the idb command line.

const STATE = '/tmp/idb/state';

// Where the companion of a simulator listens: idb connect writes it to /tmp/idb/state.
export function companionAddress(udid, stateFile = STATE) {
  try {
    const all = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const c = all.find((x) => x.udid === udid);
    if (c?.path && fs.existsSync(c.path)) return { path: c.path };
    if (c?.host && c?.port) return { host: c.host, port: c.port };
  } catch {}
  const sock = `/tmp/idb/${udid}_companion.sock`;
  return fs.existsSync(sock) ? { path: sock } : null;
}

// ── proto3 wire format, just enough of it ──────────────────────────────────────
const varint = (n) => {
  const out = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
const double = (field, v) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return Buffer.concat([tag(field, 1), b]);
};
const int = (field, v) => Buffer.concat([tag(field, 0), varint(v)]);
const sub = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);

// { field: [values] }; length-delimited values stay Buffers
export function decode(buf) {
  const out = {};
  let i = 0;
  const readVarint = () => {
    let r = 0n;
    let s = 0n;
    let c;
    do {
      if (i >= buf.length) throw new Error('truncated message');
      c = buf[i++];
      r |= BigInt(c & 0x7f) << s;
      s += 7n;
    } while (c & 0x80);
    return r;
  };
  while (i < buf.length) {
    const k = Number(readVarint());
    const field = k >> 3;
    const wire = k & 7;
    let v;
    if (wire === 0) v = readVarint();
    else if (wire === 1) (v = buf.readDoubleLE(i)), (i += 8);
    else if (wire === 2) {
      const len = Number(readVarint());
      v = buf.subarray(i, i + len);
      i += len;
    } else if (wire === 5) (v = buf.readUInt32LE(i)), (i += 4);
    else throw new Error(`wire type ${wire}`);
    (out[field] ??= []).push(v);
  }
  return out;
}

// HIDEvent { press = 1: HIDPress { action = 1: HIDPressAction { touch = 1: HIDTouch { point = 1 } }, direction = 2 } }
export const touch = (x, y, direction) => sub(1, Buffer.concat([sub(1, sub(1, sub(1, Buffer.concat([double(1, x), double(2, y)])))), int(2, direction)]));

const frame = (b) => {
  const h = Buffer.alloc(5);
  h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
};

export class Companion {
  constructor(address, { timeout = 30_000 } = {}) {
    this.address = address;
    this.timeout = timeout;
    this.session = null;
    this.busy = 0;
  }

  connect() {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const a = this.address;
    const s = http2.connect('http://localhost', { createConnection: () => (a.path ? net.connect(a.path) : net.connect(a.port, a.host)) });
    s.on('error', () => {}); // surfaces on the request
    s.on('close', () => this.session === s && (this.session = null));
    s.unref();
    this.session = s;
    return s;
  }

  // One unary or client-streaming call: send the messages, return the one reply message.
  call(method, messages) {
    return new Promise((resolve, reject) => {
      const s = this.connect();
      if (this.busy++ === 0) s.ref(); // keep the process alive only while a call is open
      let finished = false;
      const done = (fn, v) => {
        if (finished) return; // a late answer after the timeout
        finished = true;
        clearTimeout(timer);
        if (--this.busy === 0 && !s.destroyed) s.unref();
        fn(v);
      };
      const req = s.request({ ':method': 'POST', ':path': `/idb.CompanionService/${method}`, 'content-type': 'application/grpc', te: 'trailers' });
      const timer = setTimeout(() => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        done(reject, new Error(`idb_companion ${method}: no answer in ${this.timeout / 1000} s`));
      }, this.timeout);
      const chunks = [];
      let status = null;
      req.on('response', (h) => h['grpc-status'] != null && (status = h));
      req.on('trailers', (t) => (status = t));
      req.on('data', (c) => chunks.push(c));
      req.on('error', (e) => done(reject, e));
      req.on('end', () => {
        const code = status?.['grpc-status'];
        if (code != null && String(code) !== '0') return done(reject, new Error(`idb_companion ${method}: ${decodeURIComponent(status['grpc-message'] || `status ${code}`)}`));
        const b = Buffer.concat(chunks);
        if (b.length < 5) return done(reject, new Error(`idb_companion ${method}: empty answer`));
        done(resolve, b.subarray(5, 5 + b.readUInt32BE(1)));
      });
      for (const m of messages) req.write(frame(m));
      req.end();
    });
  }

  // The same JSON as `idb ui describe-all --json`. clientType: the assistive client the read
  // claims to be (AccessibilityInfoRequest.client_type = 14), 5 = XCTest: the automation tree
  async describeAll({ clientType = 0 } = {}) {
    const req = clientType ? int(14, clientType) : Buffer.alloc(0);
    const r = decode(await this.call('accessibility_info', [req]));
    return JSON.parse(r[1]?.[0]?.toString('utf8') || '[]');
  }

  // the element at a point (AccessibilityInfoRequest.point = 2), as `idb ui describe-point --json`
  async describePoint(x, y) {
    const r = decode(await this.call('accessibility_info', [sub(2, Buffer.concat([double(1, x), double(2, y)]))]));
    return JSON.parse(r[1]?.[0]?.toString('utf8') || 'null');
  }

  // HIDEvent { swipe = 2: HIDSwipe { start = 1, end = 2, delta = 5 (points per step), duration = 6 (s) } }
  async swipe(x1, y1, x2, y2, { duration = 0.5, delta = 0 } = {}) {
    const pt = (x, y) => Buffer.concat([double(1, x), double(2, y)]);
    const swipe = Buffer.concat([sub(1, pt(x1, y1)), sub(2, pt(x2, y2)), ...(delta ? [double(5, delta)] : []), double(6, duration)]);
    await this.call('hid', [sub(2, swipe)]);
  }

  async tap(x, y) {
    await this.call('hid', [touch(x, y, 0), touch(x, y, 1)]);
  }

  // PNG bytes at the screen's pixel size, as simctl io screenshot writes them
  async screenshot() {
    const r = decode(await this.call('screenshot', [Buffer.alloc(0)]));
    const png = r[1]?.[0];
    if (!png?.length) throw new Error('idb_companion screenshot: no image');
    return png;
  }

  close() {
    this.session?.close();
    this.session = null;
  }
}
