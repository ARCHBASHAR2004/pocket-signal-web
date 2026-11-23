// Price action + features + signal engine - port of posignal/engine/{patterns,features,scoring,signals}.py
import * as ind from "./indicators.js";

const isnum = Number.isFinite;
const clip = (x) => (isnum(x) ? Math.max(-1, Math.min(1, x)) : 0);
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// ------------------------------------------------------------------ price action
export function anatomy(o, h, l, c) {
  const rng = Math.max(h - l, 1e-12), body = Math.abs(c - o);
  return { bodyFrac: body / rng, upperWick: (h - Math.max(o, c)) / rng, lowerWick: (Math.min(o, c) - l) / rng, bullish: c > o };
}

export function detectPatterns(o, h, l, c) {
  const n = c.length, out = [];
  if (n < 3) return out;
  const a = anatomy(o[n - 1], h[n - 1], l[n - 1], c[n - 1]), p = anatomy(o[n - 2], h[n - 2], l[n - 2], c[n - 2]);
  if (a.bullish && !p.bullish && c[n - 1] >= o[n - 2] && o[n - 1] <= c[n - 2] && a.bodyFrac > 0.5) out.push(["ابتلاع شرائي", 0.8]);
  if (!a.bullish && p.bullish && c[n - 1] <= o[n - 2] && o[n - 1] >= c[n - 2] && a.bodyFrac > 0.5) out.push(["ابتلاع بيعي", -0.8]);
  if (a.lowerWick > 0.6 && a.bodyFrac < 0.3) out.push(["مطرقة", 0.6]);
  if (a.upperWick > 0.6 && a.bodyFrac < 0.3) out.push(["شهاب", -0.6]);
  if (a.bodyFrac < 0.08) out.push(["دوجي (تردد)", 0]);
  if ([1, 2, 3].every((k) => c[n - k] > o[n - k]) && c[n - 1] > c[n - 2] && c[n - 2] > c[n - 3]) out.push(["ثلاثة جنود بيض", 0.5]);
  if ([1, 2, 3].every((k) => c[n - k] < o[n - k]) && c[n - 1] < c[n - 2] && c[n - 2] < c[n - 3]) out.push(["ثلاثة غربان سود", -0.5]);
  return out;
}

function pivots(h, l, left = 3, right = 3) {
  const hi = [], lo = [];
  for (let i = left; i < h.length - right; i++) {
    let mx = -Infinity, mn = Infinity;
    for (let j = i - left; j <= i + right; j++) { mx = Math.max(mx, h[j]); mn = Math.min(mn, l[j]); }
    if (h[i] === mx) hi.push(i);
    if (l[i] === mn) lo.push(i);
  }
  return [hi, lo];
}

export function srZones(h, l, c, atrVal, lookback = 150, maxZones = 6) {
  h = h.slice(-lookback); l = l.slice(-lookback);
  if (h.length < 10 || !isnum(atrVal) || atrVal <= 0) return [];
  const [hi, lo] = pivots(h, l);
  const levels = [...hi.map((i) => h[i]), ...lo.map((i) => l[i])].sort((a, b) => a - b);
  const width = 0.5 * atrVal, clusters = [];
  for (const lv of levels) {
    const last = clusters[clusters.length - 1];
    if (last && lv - last[last.length - 1] <= width) last.push(lv); else clusters.push([lv]);
  }
  const price = c[c.length - 1];
  const zones = clusters.filter((cl) => cl.length >= 2).map((cl) => {
    const m = cl.reduce((s, v) => s + v, 0) / cl.length;
    return { level: m, lo: Math.min(...cl) - width / 2, hi: Math.max(...cl) + width / 2, touches: cl.length,
             kind: m < price ? "support" : "resistance" };
  });
  zones.sort((a, b) => b.touches - a.touches || Math.abs(a.level - price) - Math.abs(b.level - price));
  return zones.slice(0, maxZones);
}

export function marketStructure(h, l, lookback = 60) {
  const hh = h.slice(-lookback), ll = l.slice(-lookback);
  const [hi, lo] = pivots(hh, ll);
  const H = hi.map((i) => hh[i]).slice(-2), L = lo.map((i) => ll[i]).slice(-2);
  if (H.length === 2 && L.length === 2) {
    if (H[1] > H[0] && L[1] > L[0]) return "uptrend";
    if (H[1] < H[0] && L[1] < L[0]) return "downtrend";
  }
  return "range";
}

export function breakout(o, h, l, c, zones, atrVal) {
  const n = c.length;
  if (!zones.length || n < 2) return ["", 0];
  for (const z of zones) {
    const a = anatomy(o[n - 1], h[n - 1], l[n - 1], c[n - 1]);
    if (z.kind === "resistance" && c[n - 2] <= z.hi && z.hi < c[n - 1] && a.bodyFrac > 0.55) return ["اختراق مقاومة", 0.6];
    if (z.kind === "support" && c[n - 2] >= z.lo && z.lo > c[n - 1] && a.bodyFrac > 0.55) return ["كسر دعم", -0.6];
    if (h[n - 1] > z.hi && c[n - 1] < z.level && z.level > c[n - 1] - 2 * atrVal) return ["اختراق كاذب / رفض", -0.7];
    if (l[n - 1] < z.lo && c[n - 1] > z.level && z.level < c[n - 1] + 2 * atrVal) return ["كسر كاذب / رفض", 0.7];
  }
  return ["", 0];
}

// ------------------------------------------------------------------ features
export const FEATURES = ["ema_stack", "ema200_side", "rsi", "macd_hist", "bb_pos", "stoch", "adx_dir", "supertrend",
  "pattern", "breakout", "structure", "htf_trend", "body_momentum"];

export function aggregate(candles, factor) {
  const out = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const g = candles.slice(i, i + factor);
    out.push({ ts: g[0].ts, open: g[0].open, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)),
               close: g[g.length - 1].close });
  }
  return out;
}

const last = (a) => a[a.length - 1];

export function compute(candles, htfMultiple = 5) {
  const win = candles.slice(-400);
  const o = win.map((x) => x.open), h = win.map((x) => x.high), l = win.map((x) => x.low), c = win.map((x) => x.close);
  const htfClose = aggregate(win, htfMultiple).map((x) => x.close);
  const e9 = ind.ema(c, 9), e21 = ind.ema(c, 21), e50 = ind.ema(c, 50), e200 = ind.ema(c, 200);
  const r = ind.rsi(c, 14), m = ind.macd(c), bb = ind.bollinger(c), st = ind.stochastic(h, l, c);
  const ax = ind.adx(h, l, c), at = ind.atr(h, l, c), sup = ind.supertrend(h, l, c);

  let a = last(at);
  if (!(isnum(a) && a > 0)) {
    const d = c.slice(-50).map((v, i, arr) => (i ? v - arr[i - 1] : 0)).slice(1);
    const mu = d.reduce((s, v) => s + v, 0) / d.length;
    a = Math.max(Math.sqrt(d.reduce((s, v) => s + (v - mu) ** 2, 0) / d.length), 1e-12);
  }
  const price = last(c);
  let stack = 0;
  if (last(e9) > last(e21) && last(e21) > last(e50)) stack = 1;
  else if (last(e9) < last(e21) && last(e21) < last(e50)) stack = -1;
  else stack = 0.5 * sign(last(e9) - last(e21));
  const width = bb.upper.map((u, i) => (u - bb.lower[i]) / bb.mid[i]);
  const bbHalf = last(bb.upper) - last(bb.mid) || 1e-12;
  const k = last(st.k), d = last(st.d);
  const stochCross = isnum(k) && isnum(d) ? sign(k - d) : 0;
  const pdi = last(ax.pdi), mdi = last(ax.mdi), adxv = last(ax.adx);
  const diSum = pdi + mdi || 1e-12;

  const zones = srZones(h, l, c, a);
  const structure = marketStructure(h, l);
  const pats = detectPatterns(o, h, l, c);
  const [boDesc, boVote] = breakout(o, h, l, c, zones, a);
  const an = anatomy(last(o), last(h), last(l), last(c));
  let htf = 0;
  if (htfClose.length >= 22) {
    const he = ind.ema(htfClose, 21), n = he.length;
    if (isnum(he[n - 1]) && isnum(he[n - 2])) htf = sign(he[n - 1] - he[n - 2]) * (last(htfClose) > he[n - 1] ? 1 : 0.5);
  }
  const features = {
    ema_stack: clip(stack), ema200_side: clip((price - last(e200)) / (3 * a)), rsi: clip((last(r) - 50) / 50),
    macd_hist: clip(Math.tanh(last(m.hist) / (0.25 * a))), bb_pos: clip((price - last(bb.mid)) / bbHalf),
    stoch: clip((0.7 * (k - 50)) / 50 + 0.3 * stochCross),
    adx_dir: clip(((pdi - mdi) / diSum) * Math.min(1, (adxv || 0) / 25)), supertrend: clip(last(sup.dir)),
    pattern: clip(pats.reduce((s, p) => s + p[1], 0)), breakout: clip(boVote),
    structure: structure === "uptrend" ? 1 : structure === "downtrend" ? -1 : 0,
    htf_trend: clip(htf), body_momentum: clip((an.bullish ? 1 : -1) * an.bodyFrac),
  };
  const readings = { EMA9: last(e9), EMA21: last(e21), EMA50: last(e50), EMA200: last(e200), RSI14: last(r),
    MACD_hist: last(m.hist), BB_upper: last(bb.upper), BB_mid: last(bb.mid), BB_lower: last(bb.lower), Stoch_K: k,
    Stoch_D: d, ADX14: adxv, "+DI": pdi, "-DI": mdi, ATR14: a, Supertrend: last(sup.line), Supertrend_dir: last(sup.dir) };
  return {
    features, readings, atr: a, atrPct: ind.percentileRank(at.map((v, i) => v / c[i])),
    bbWidthPct: ind.percentileRank(width), adx: isnum(adxv) ? adxv : 0, zones, structure, patterns: pats, breakoutDesc: boDesc,
    series: { e9, e21, e50, e200, bbU: bb.upper, bbM: bb.mid, bbL: bb.lower, st: sup.line, stDir: sup.dir },
  };
}

// ------------------------------------------------------------------ scoring (uncalibrated prior, as desktop)
export const PRIOR = { ema_stack: 1, ema200_side: 0.5, rsi: 0.3, macd_hist: 0.8, bb_pos: 0.2, stoch: 0.3, adx_dir: 0.8,
  supertrend: 1, pattern: 0.5, breakout: 0.6, structure: 0.6, htf_trend: 0.8, body_momentum: 0.3 };

export function rawScore(features, w = PRIOR) {
  let num = 0, den = 0;
  for (const f of FEATURES) { num += (w[f] || 0) * features[f]; den += Math.abs(w[f] || 0); }
  return den ? num / den : 0;
}
export const breakeven = (payout) => 1 / (1 + payout);

export const DEFAULT_CFG = { minBars: 210, cutoff: 0.5, edgeModerate: 0.03, edgeHigh: 0.06, minRaw: 0.25,
  adxSideways: 18, bbWidthSideways: 20, atrPctMin: 10, atrPctMax: 97, staleFactor: 1.5, htfMultiple: 5 };

/** Analyse after a candle CLOSES; entry is for the NEXT candle. Mirrors SignalEngine.analyze. */
export function analyze(candles, tf, now, payout = 0.85, cfg = DEFAULT_CFG) {
  const res = { direction: "NONE", quality: "NO_TRADE", reasons: [], probability: 0, raw: 0, breakeven: breakeven(payout),
                entryPrice: candles.length ? last(candles).close : 0, deadline: now, snap: null };
  if (candles.length < cfg.minBars) { res.quality = "DATA_UNAVAILABLE"; res.reasons.push(`بيانات غير كافية (${candles.length}/${cfg.minBars})`); return res; }
  const lc = last(candles);
  const stale = Math.max(3, tf * cfg.staleFactor);
  if (now - (lc.ts + tf) > stale) { res.quality = "DATA_UNAVAILABLE"; res.reasons.push("بيانات قديمة"); return res; }
  const ts = candles.slice(-cfg.minBars).map((x) => x.ts);
  let maxGap = 0, irregular = 0;
  for (let i = 1; i < ts.length; i++) { const g = ts[i] - ts[i - 1]; maxGap = Math.max(maxGap, g); if (g !== tf) irregular++; }
  if (maxGap > 10 * tf) { res.quality = "DATA_UNAVAILABLE"; res.reasons.push("فجوة في البيانات"); return res; }
  if (irregular / (ts.length - 1) > 0.05) { res.quality = "DATA_UNAVAILABLE"; res.reasons.push("بيانات غير منتظمة"); return res; }

  const snap = compute(candles, cfg.htfMultiple);
  res.snap = snap;
  if (snap.adx < cfg.adxSideways && snap.bbWidthPct < cfg.bbWidthSideways) res.reasons.push(`سوق عرضي (ADX ${snap.adx.toFixed(1)})`);
  if (snap.atrPct < cfg.atrPctMin) res.reasons.push("تذبذب منخفض جداً");
  if (snap.atrPct > cfg.atrPctMax) res.reasons.push("تذبذب مفرط");
  const raw = rawScore(snap.features);
  const pu = 0.5 + 0.1 * raw;                          // humble uncalibrated prior (same as desktop)
  const dir = pu >= 0.5 ? "CALL" : "PUT";
  const p = dir === "CALL" ? pu : 1 - pu;
  const edge = p - res.breakeven;
  res.raw = raw; res.probability = p;
  if (Math.abs(raw) < cfg.minRaw) res.reasons.push(`توافق ضعيف بين المؤشرات (${raw.toFixed(2)})`);
  let quality;
  if (res.reasons.length) quality = "NO_TRADE";
  else if (edge >= cfg.edgeHigh) quality = "MODERATE";  // uncalibrated -> never HIGH
  else if (edge >= cfg.edgeModerate) quality = "MODERATE";
  else { quality = "NO_TRADE"; res.reasons.push(`الأفضلية ${(edge * 100).toFixed(1)}% أقل من الحد`); }
  const entryOpen = lc.ts + tf;
  res.deadline = entryOpen + tf * cfg.cutoff;
  if (quality !== "NO_TRADE" && now >= res.deadline) { quality = "EXPIRED"; res.reasons.push("انتهى وقت الدخول"); }
  res.quality = quality;
  res.direction = quality === "NO_TRADE" ? "NONE" : dir;
  return res;
}
