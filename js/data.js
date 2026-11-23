// Live market data for the browser: Binance (crypto, no key), Twelve Data (FX/metals/stocks/crypto, key),
// and a clearly-labelled SIMULATION feed. Candles are epoch-aligned; gaps are never filled.

export const ASSETS = {
  binance: [
    { id: "BTCUSDT", name: "BTC/USDT", cat: "crypto" }, { id: "ETHUSDT", name: "ETH/USDT", cat: "crypto" },
    { id: "SOLUSDT", name: "SOL/USDT", cat: "crypto" }, { id: "BNBUSDT", name: "BNB/USDT", cat: "crypto" },
    { id: "XRPUSDT", name: "XRP/USDT", cat: "crypto" },
  ],
  twelvedata: [
    { id: "EUR/USD", name: "EUR/USD", cat: "fx" }, { id: "GBP/USD", name: "GBP/USD", cat: "fx" },
    { id: "USD/JPY", name: "USD/JPY", cat: "fx" }, { id: "AUD/USD", name: "AUD/USD", cat: "fx" },
    { id: "EUR/JPY", name: "EUR/JPY", cat: "fx" }, { id: "USD/CAD", name: "USD/CAD", cat: "fx" },
    { id: "XAU/USD", name: "الذهب XAU/USD", cat: "metal" }, { id: "XAG/USD", name: "الفضة XAG/USD", cat: "metal" },
    { id: "BTC/USD", name: "BTC/USD", cat: "crypto" }, { id: "AAPL", name: "Apple", cat: "stock" },
    { id: "TSLA", name: "Tesla", cat: "stock" }, { id: "NVDA", name: "NVIDIA", cat: "stock" },
  ],
  simulation: [
    { id: "SIM_EURUSD", name: "SIM EUR/USD", cat: "fx" }, { id: "SIM_XAUUSD", name: "SIM الذهب", cat: "metal" },
    { id: "SIM_BTCUSD", name: "SIM BTC", cat: "crypto" },
  ],
};

const openOf = (ts, tf) => Math.floor(ts / tf) * tf;

export class CandleBuilder {
  constructor(tf, max = 600) { this.tf = tf; this.max = max; this.cur = null; this.closed = []; }
  seed(list) { this.closed = list.slice(-this.max); }
  tick(ts, price, high = price, low = price) {
    const start = openOf(ts, this.tf);
    let done = null;
    if (this.cur && start > this.cur.ts) done = this._close();
    if (!this.cur) {
      const lastClosed = this.closed[this.closed.length - 1];
      if (lastClosed && start <= lastClosed.ts) return done;     // late tick
      this.cur = { ts: start, open: price, high, low, close: price };
    } else {
      this.cur.high = Math.max(this.cur.high, high); this.cur.low = Math.min(this.cur.low, low); this.cur.close = price;
    }
    return done;
  }
  due(now) { return this.cur && now >= this.cur.ts + this.tf + 0.25 ? this._close() : null; }
  _close() { const c = this.cur; this.closed.push(c); if (this.closed.length > this.max) this.closed.shift(); this.cur = null; return c; }
}

class BaseFeed {
  constructor() {
    this.builders = new Map(); this.last = new Map(); this.listeners = new Set();
    this.health = { connected: false, lastTick: 0, error: "" };
    this._clock = setInterval(() => this._due(), 200);
  }
  key(sym, tf) { return `${sym}|${tf}`; }
  candles(sym, tf) { return this.builders.get(this.key(sym, tf))?.closed ?? []; }
  forming(sym, tf) { return this.builders.get(this.key(sym, tf))?.cur ?? null; }
  lastPrice(sym) { return this.last.get(sym); }
  onCandle(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  _emit(sym, tf, c) { for (const cb of this.listeners) { try { cb(sym, tf, c); } catch (e) { console.error(e); } } }
  _tick(sym, ts, price, hi, lo) {
    this.health.lastTick = Date.now() / 1000; this.last.set(sym, price);
    for (const [k, b] of this.builders) {
      if (!k.startsWith(sym + "|")) continue;
      const done = b.tick(ts, price, hi ?? price, lo ?? price);
      if (done) this._emit(sym, b.tf, done);
    }
  }
  _due() {
    const now = Date.now() / 1000;
    for (const [k, b] of this.builders) { const d = b.due(now); if (d) this._emit(k.split("|")[0], b.tf, d); }
  }
  stop() { clearInterval(this._clock); }
}

// ------------------------------------------------------------------ Binance (public market data, CORS-enabled)
const BN_REST = ["https://data-api.binance.vision/api/v3/klines", "https://api.binance.com/api/v3/klines"];
const BN_WS = ["wss://data-stream.binance.vision/ws", "wss://stream.binance.com:9443/ws"];

export class BinanceFeed extends BaseFeed {
  constructor() { super(); this.source = "binance"; this.subs = new Set(); this.ws = null; this.wsIdx = 0; this._connect(); }
  async _klines(sym, interval, limit, endTime) {
    let lastErr;
    for (const base of BN_REST) {
      try {
        const u = new URL(base); u.search = new URLSearchParams({ symbol: sym, interval, limit, ...(endTime ? { endTime } : {}) });
        const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()).map((k) => ({ ts: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  async ensure(sym, tf) {
    const key = this.key(sym, tf);
    if (this.builders.has(key)) return;
    const b = new CandleBuilder(tf); this.builders.set(key, b);
    const now = Date.now() / 1000;
    let hist;
    const native = { 60: "1m", 180: "3m", 300: "5m", 900: "15m", 1800: "30m" };
    if (tf < 60) {
      let bars = [], end;
      while (bars.length < tf * 260) {
        const chunk = await this._klines(sym, "1s", 1000, end);
        if (!chunk.length) break;
        bars = chunk.concat(bars); end = chunk[0].ts * 1000 - 1;
      }
      hist = aggregateBars(bars, tf);
    } else if (native[tf]) hist = await this._klines(sym, native[tf], 400);
    else hist = aggregateBars(await this._klines(sym, "1m", 1000), tf);
    b.seed(hist.filter((c) => c.ts + tf <= now));
    this._subscribe(sym);
  }
  _subscribe(sym) {
    this.subs.add(sym.toLowerCase());
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [`${sym.toLowerCase()}@kline_1s`], id: Date.now() }));
  }
  _connect() {
    const ws = new WebSocket(BN_WS[this.wsIdx % BN_WS.length]); this.ws = ws;
    ws.onopen = () => {
      this.health.connected = true; this.health.error = "";
      if (this.subs.size) ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [...this.subs].map((s) => `${s}@kline_1s`), id: 1 }));
    };
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data); const k = d.k; if (!k) return;
      this._tick(k.s, k.t / 1000, +k.c, +k.h, +k.l);
    };
    ws.onclose = () => { this.health.connected = false; if (!this.stopped) { this.wsIdx++; setTimeout(() => this._connect(), 2000); } };
    ws.onerror = () => { this.health.error = "Binance connection error"; };
  }
  stop() { this.stopped = true; super.stop(); this.ws?.close(); }
}

export function aggregateBars(bars, tf) {
  const out = [];
  for (const b of bars) {
    const s = openOf(b.ts, tf), c = out[out.length - 1];
    if (c && c.ts === s) { c.high = Math.max(c.high, b.high); c.low = Math.min(c.low, b.low); c.close = b.close; }
    else out.push({ ts: s, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  return out;
}

// ------------------------------------------------------------------ Twelve Data
export class TwelveDataFeed extends BaseFeed {
  constructor(apiKey) {
    super(); this.source = "twelvedata"; this.apiKey = apiKey; this.subs = new Set(); this.lastReq = 0; this._connect();
  }
  async _series(sym, interval, size) {
    const wait = this.lastReq + 8000 - Date.now();                 // free plan ~8 requests/minute
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastReq = Date.now();
    const u = new URL("https://api.twelvedata.com/time_series");
    u.search = new URLSearchParams({ symbol: sym, interval, outputsize: size, timezone: "UTC", apikey: this.apiKey });
    const r = await fetch(u); const j = await r.json();
    if (j.status === "error") throw new Error(`Twelve Data ${j.code}: ${j.message}`);
    return (j.values || []).map((v) => ({ ts: Date.parse(v.datetime.replace(" ", "T") + "Z") / 1000, open: +v.open,
      high: +v.high, low: +v.low, close: +v.close })).sort((a, b) => a.ts - b.ts);
  }
  async ensure(sym, tf) {
    const key = this.key(sym, tf); if (this.builders.has(key)) return;
    const b = new CandleBuilder(tf); this.builders.set(key, b);
    const now = Date.now() / 1000;
    const native = { 60: "1min", 300: "5min", 900: "15min", 1800: "30min" };
    let hist = [];
    if (tf >= 60) hist = native[tf] ? await this._series(sym, native[tf], 400) : aggregateBars(await this._series(sym, "1min", 3000), tf);
    b.seed(hist.filter((c) => c.ts + tf <= now));                   // <60s: no seconds history -> built live
    this.subs.add(sym);
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ action: "subscribe", params: { symbols: sym } }));
  }
  _connect() {
    const ws = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(this.apiKey)}`); this.ws = ws;
    ws.onopen = () => {
      this.health.connected = true;
      if (this.subs.size) ws.send(JSON.stringify({ action: "subscribe", params: { symbols: [...this.subs].join(",") } }));
      this.hb = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ action: "heartbeat" })), 10000);
    };
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.event === "price") this._tick(d.symbol, +d.timestamp, +d.price);
      else if (d.event === "subscribe-status" && d.fails?.length) this.health.error = "رفضت Twelve Data بعض الأصول: " + d.fails.map((f) => f.symbol).join(", ");
    };
    ws.onclose = () => { this.health.connected = false; clearInterval(this.hb); if (!this.stopped) setTimeout(() => this._connect(), 3000); };
    ws.onerror = () => { this.health.error = "Twelve Data connection error"; };
  }
  stop() { this.stopped = true; super.stop(); clearInterval(this.hb); this.ws?.close(); }
}

// ------------------------------------------------------------------ SIMULATION (synthetic - always labelled)
const SIM = { SIM_EURUSD: [1.085, 0.00004], SIM_XAUUSD: [2400, 0.00008], SIM_BTCUSD: [65000, 0.00015] };
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
class Path {
  constructor(p, sigma) { this.p = p; this.sigma = sigma; this.drift = 0; this.vm = 1; }
  step(dt = 1) {
    if (Math.random() < 0.01 * dt) { this.drift = [0, 0, 1, -1][Math.floor(Math.random() * 4)] * this.sigma * (0.05 + Math.random() * 0.25); this.vm = [0.5, 1, 1, 2][Math.floor(Math.random() * 4)]; }
    this.p *= Math.exp(this.drift * dt + gauss() * this.sigma * this.vm * Math.sqrt(dt)); return this.p;
  }
}
export class SimFeed extends BaseFeed {
  constructor() {
    super(); this.source = "simulation"; this.health.connected = true;
    this.paths = new Map(Object.entries(SIM).map(([k, [p, s]]) => [k, new Path(p, s)]));
    this._timer = setInterval(() => {
      const now = Date.now() / 1000;
      for (const [sym, path] of this.paths) if ([...this.builders.keys()].some((k) => k.startsWith(sym + "|"))) this._tick(sym, now, path.step(0.25));
    }, 250);
  }
  async ensure(sym, tf) {
    const key = this.key(sym, tf); if (this.builders.has(key)) return;
    const b = new CandleBuilder(tf); this.builders.set(key, b);
    const [p0, s] = SIM[sym]; const path = new Path(p0, s); const n = 260;
    const end = openOf(Date.now() / 1000, tf); const hist = [];
    for (let i = 0; i < n; i++) {
      const o = path.p; let hi = o, lo = o;
      for (let k = 0; k < tf; k++) { const p = path.step(); hi = Math.max(hi, p); lo = Math.min(lo, p); }
      hist.push({ ts: end - (n - i) * tf, open: o, high: hi, low: lo, close: path.p });
    }
    const cur = this.paths.get(sym).p, f = cur / hist[hist.length - 1].close;
    for (const c of hist) { c.open *= f; c.high *= f; c.low *= f; c.close *= f; }
    b.seed(hist);
  }
  stop() { super.stop(); clearInterval(this._timer); }
}

export function makeFeed(source, key) {
  if (source === "binance") return new BinanceFeed();
  if (source === "twelvedata") { if (!key) throw new Error("أدخل مفتاح Twelve Data في الإعدادات"); return new TwelveDataFeed(key); }
  return new SimFeed();
}
