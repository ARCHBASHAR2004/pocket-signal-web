// Technical indicators - JavaScript port of posignal/engine/indicators.py.
// Same formulas (SMA-seeded EMA, Wilder smoothing for RSI/ATR/ADX, population std for Bollinger).
// Parity with the Python engine is checked by tests/test_web_parity.py.
const NaN_ = Number.NaN;
const full = (n) => new Array(n).fill(NaN_);
const isnum = (x) => Number.isFinite(x);

export function ema(x, period) {
  const out = full(x.length);
  if (x.length < period) return out;
  const a = 2 / (period + 1);
  let s = 0;
  for (let i = 0; i < period; i++) s += x[i];
  out[period - 1] = s / period;
  for (let i = period; i < x.length; i++) out[i] = a * x[i] + (1 - a) * out[i - 1];
  return out;
}

export function sma(x, period) {
  const out = full(x.length);
  if (x.length < period) return out;
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= period) s -= x[i - period];
    if (i >= period - 1) out[i] = s / period;
  }
  return out;
}

function wilder(x, period, start = 0) {
  const out = full(x.length);
  if (x.length - start < period) return out;
  const seed = start + period - 1;
  let s = 0;
  for (let i = start; i < start + period; i++) s += x[i];
  out[seed] = s / period;
  for (let i = seed + 1; i < x.length; i++) out[i] = (out[i - 1] * (period - 1) + x[i]) / period;
  return out;
}

export function rsi(close, period = 14) {
  const n = close.length, out = full(n);
  if (n <= period) return out;
  const gain = [], loss = [];
  for (let i = 1; i < n; i++) {
    const d = close[i] - close[i - 1];
    gain.push(d > 0 ? d : 0); loss.push(d < 0 ? -d : 0);
  }
  const ag = wilder(gain, period), al = wilder(loss, period);
  for (let i = 0; i < gain.length; i++) {
    if (!isnum(ag[i])) continue;
    let r;
    if (al[i] === 0) r = ag[i] > 0 ? 100 : 50;
    else r = 100 - 100 / (1 + ag[i] / al[i]);
    out[i + 1] = r;
  }
  return out;
}

function smaNan(x, period) {
  const out = full(x.length);
  const first = x.findIndex(isnum);
  if (first < 0 || x.length - first < period) return out;
  const s = sma(x.slice(first), period);
  for (let i = 0; i < s.length; i++) out[first + i] = s[i];
  return out;
}

function emaNan(x, period) {
  const out = full(x.length);
  const first = x.findIndex(isnum);
  if (first < 0 || x.length - first < period) return out;
  const e = ema(x.slice(first), period);
  for (let i = 0; i < e.length; i++) out[first + i] = e[i];
  return out;
}

export function macd(close, fast = 12, slow = 26, signal = 9) {
  const ef = ema(close, fast), es = ema(close, slow);
  const line = ef.map((v, i) => v - es[i]);
  const sig = emaNan(line, signal);
  return { line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

export function bollinger(close, period = 20, k = 2) {
  const n = close.length, mid = sma(close, period), upper = full(n), lower = full(n);
  for (let i = period - 1; i < n; i++) {
    let s2 = 0;
    for (let j = i - period + 1; j <= i; j++) s2 += (close[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s2 / period);
    upper[i] = mid[i] + k * sd; lower[i] = mid[i] - k * sd;
  }
  return { upper, mid, lower };
}

export function stochastic(high, low, close, kp = 14, ks = 3, dp = 3) {
  const n = close.length, raw = full(n);
  for (let i = kp - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kp + 1; j <= i; j++) { hh = Math.max(hh, high[j]); ll = Math.min(ll, low[j]); }
    const rng = hh - ll;
    raw[i] = rng > 0 ? (100 * (close[i] - ll)) / rng : 50;
  }
  const k = smaNan(raw, ks);
  return { k, d: smaNan(k, dp) };
}

export function trueRange(high, low, close) {
  return close.map((c, i) => i === 0 ? high[0] - low[0]
    : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
}

export function atr(high, low, close, period = 14) {
  return wilder(trueRange(high, low, close), period, 1);
}

export function adx(high, low, close, period = 14) {
  const n = close.length, pdm = new Array(n).fill(0), mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1], dn = low[i - 1] - low[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = trueRange(high, low, close);
  const a = wilder(tr, period, 1), sp = wilder(pdm, period, 1), sm = wilder(mdm, period, 1);
  const pdi = full(n), mdi = full(n), dx = full(n);
  for (let i = 0; i < n; i++) {
    if (!isnum(a[i])) continue;
    pdi[i] = (100 * sp[i]) / a[i]; mdi[i] = (100 * sm[i]) / a[i];
    const d = (100 * Math.abs(pdi[i] - mdi[i])) / (pdi[i] + mdi[i]);
    dx[i] = isnum(d) ? d : 0;
  }
  const out = full(n);
  const first = dx.findIndex(isnum);
  if (first >= 0 && n - first >= period) {
    const w = wilder(dx.slice(first), period);
    for (let i = 0; i < w.length; i++) out[first + i] = w[i];
  }
  return { adx: out, pdi, mdi };
}

export function supertrend(high, low, close, period = 10, mult = 3) {
  const n = close.length, a = atr(high, low, close, period);
  const line = full(n), dir = full(n);
  const ub = [], lb = [];
  for (let i = 0; i < n; i++) {
    const hl2 = (high[i] + low[i]) / 2;
    ub.push(hl2 + mult * a[i]); lb.push(hl2 - mult * a[i]);
  }
  const fub = ub.slice(), flb = lb.slice();
  const start = a.findIndex(isnum);
  if (start < 0) return { line, dir };
  for (let i = start; i < n; i++) {
    if (i === start) { dir[i] = 1; line[i] = flb[i]; continue; }
    fub[i] = ub[i] < fub[i - 1] || close[i - 1] > fub[i - 1] ? ub[i] : fub[i - 1];
    flb[i] = lb[i] > flb[i - 1] || close[i - 1] < flb[i - 1] ? lb[i] : flb[i - 1];
    if (dir[i - 1] === 1) dir[i] = close[i] < flb[i] ? -1 : 1;
    else dir[i] = close[i] > fub[i] ? 1 : -1;
    line[i] = dir[i] === 1 ? flb[i] : fub[i];
  }
  return { line, dir };
}

export function percentileRank(x, lookback = 200) {
  const w = x.slice(-lookback).filter(isnum);
  if (w.length < 20) return 50;
  const last = w[w.length - 1];
  return (w.filter((v) => v < last).length / w.length) * 100;
}
