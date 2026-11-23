// PocketSignal web app (PWA). Signal-only: never places trades.
import { analyze, compute, DEFAULT_CFG, breakeven } from "./analysis.js";
import { ASSETS, makeFeed } from "./data.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const AR = (n) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);
const fmt = (x) => !Number.isFinite(x) ? "-" : Math.abs(x) < 10 ? x.toFixed(5) : Math.abs(x) < 100000 ? x.toFixed(2) : x.toFixed(0);
const tfLabel = (s) => (s < 60 ? `${s}s` : `${s / 60}m`);
const now = () => Date.now() / 1000;

// ------------------------------------------------------------------ persistent settings (this device only)
const store = {
  get(k, d) { try { const v = localStorage.getItem("ps_" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ps_" + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const S = {
  source: store.get("source", "binance"), tdKey: store.get("tdKey", ""), payout: store.get("payout", 0.85),
  cutoff: store.get("cutoff", 0.5), results: store.get("results", []),
  tab: "signal", page: 0, market: "REAL", tf: 15, asset: null, pending: null, result: null, loading: false, error: "",
};
let feed = null;

function startFeed() {
  feed?.stop();
  S.error = ""; S.pending = null; S.result = null;
  try { feed = makeFeed(S.source, S.tdKey); } catch (e) { feed = null; S.error = e.message; }
  if (feed) feed.onCandle(onCandle);
  S.asset = ASSETS[S.source][0].id;
  $("#simbar").hidden = S.source !== "simulation";
}

// ------------------------------------------------------------------ signal flow
async function requestSignal() {
  if (!feed) { S.page = 3; S.result = { err: S.error || "شغّل مصدر البيانات من الإعدادات" }; render(); return; }
  S.page = 3; S.result = null; S.loading = true; render();
  try { await feed.ensure(S.asset, S.tf); }
  catch (e) { S.loading = false; S.result = { err: "تعذّر تحميل البيانات: " + e.message }; render(); return; }
  S.loading = false;
  S.pending = { asset: S.asset, tf: S.tf, req: now() };
  render();
}

function onCandle(sym, tf, c) {
  resolvePaper(sym, tf);
  const p = S.pending;
  if (p && p.asset === sym && p.tf === tf && c.ts + tf >= p.req - 0.5) {
    const cfg = { ...DEFAULT_CFG, cutoff: S.cutoff };
    const r = analyze(feed.candles(sym, tf), tf, now(), S.payout, cfg);
    S.pending = null;
    S.result = { ...r, asset: sym, tf, entryOpen: c.ts + tf, sim: feed.source === "simulation" };
    if (r.quality === "MODERATE" && r.direction !== "NONE") {
      S.results.unshift({ id: Date.now(), asset: sym, tf, dir: r.direction, entryOpen: c.ts + tf, exp: tf, p: r.probability,
                          sim: feed.source === "simulation", outcome: "PENDING" });
      S.results = S.results.slice(0, 300); store.set("results", S.results);
      try { navigator.vibrate?.(200); } catch { /* not supported */ }
    }
    render();
  }
}

function resolvePaper(sym, tf) {
  let changed = false;
  const byTs = new Map(feed.candles(sym, tf).map((c) => [c.ts, c]));
  for (const t of S.results) {
    if (t.outcome !== "PENDING" || t.asset !== sym || t.tf !== tf) continue;
    const entry = byTs.get(t.entryOpen), exit = byTs.get(t.entryOpen + t.exp - tf);
    if (!exit) continue;
    const e = entry ? entry.open : exit.open, mv = (exit.close - e) * (t.dir === "CALL" ? 1 : -1);
    t.outcome = mv > 0 ? "WIN" : mv < 0 ? "LOSS" : "PUSH"; changed = true;
  }
  if (changed) store.set("results", S.results);
}

// ------------------------------------------------------------------ indicator board
function evaluate(snap, price) {
  const r = snap.readings, f = snap.features;
  const side = (x, th = 0.15) => (x > th ? "صعود" : x < -th ? "هبوط" : "محايد");
  const rsi = r.RSI14, k = r.Stoch_K, adx = snap.adx, bb = f.bb_pos, vol = snap.atrPct;
  const sup = snap.zones.filter((z) => z.kind === "support"), res = snap.zones.filter((z) => z.kind === "resistance");
  const ns = sup.length ? Math.max(...sup.map((z) => z.level)) : NaN, nr = res.length ? Math.min(...res.map((z) => z.level)) : NaN;
  const sr = Number.isFinite(ns) && Number.isFinite(nr) && nr > ns ? Math.max(-1, Math.min(1, 1 - (2 * (price - ns)) / (nr - ns))) : 0;
  return [
    { n: "المتوسطات EMA 9/21/50", v: `${fmt(r.EMA9)} / ${fmt(r.EMA21)}`, d: side(f.ema_stack), s: f.ema_stack },
    { n: "EMA 200", v: fmt(r.EMA200), d: price > r.EMA200 ? "السعر فوقه" : "السعر تحته", s: f.ema200_side },
    { n: "RSI (14)", v: rsi.toFixed(1), d: rsi >= 70 ? "تشبّع شراء" : rsi <= 30 ? "تشبّع بيع" : side(f.rsi, 0.1), s: f.rsi, w: rsi >= 70 || rsi <= 30 },
    { n: "MACD (12,26,9)", v: fmt(r.MACD_hist), d: side(f.macd_hist), s: f.macd_hist },
    { n: "بولينجر (20,2)", v: `${fmt(r.BB_lower)} – ${fmt(r.BB_upper)}`, d: bb > 0.8 ? "قرب الحد العلوي" : bb < -0.8 ? "قرب الحد السفلي" : "داخل النطاق", s: bb, nc: Math.abs(bb) <= 0.8 },
    { n: "ستوكاستك (14,3,3)", v: `K ${k.toFixed(0)} / D ${r.Stoch_D.toFixed(0)}`, d: k >= 80 ? "تشبّع شراء" : k <= 20 ? "تشبّع بيع" : side(f.stoch), s: f.stoch, w: k >= 80 || k <= 20 },
    { n: "ADX (14)", v: `${adx.toFixed(1)} (+DI ${r["+DI"].toFixed(0)} / -DI ${r["-DI"].toFixed(0)})`,
      d: `${adx >= 25 ? "ترند قوي" : adx >= 18 ? "ترند ضعيف" : "سوق عرضي"} · ${side(f.adx_dir)}`, s: f.adx_dir },
    { n: "ATR (14)", v: fmt(r.ATR14), d: vol < 20 ? "تذبذب منخفض" : vol > 80 ? "تذبذب مرتفع" : "تذبذب طبيعي", s: 0, neutral: true },
    { n: "سوبر ترند (10,3)", v: fmt(r.Supertrend), d: f.supertrend > 0 ? "صعود" : "هبوط", s: f.supertrend },
    { n: "نماذج الشموع", v: snap.patterns.map((p) => p[0]).join("، ") || "لا يوجد نموذج", d: side(f.pattern), s: f.pattern },
    { n: "الدعم / المقاومة", v: `${fmt(ns)} / ${fmt(nr)}`, d: sr > 0.4 ? "قرب الدعم" : sr < -0.4 ? "قرب المقاومة" : "في المنتصف", s: sr, nc: Math.abs(sr) <= 0.4 },
  ];
}

function boardHTML(snap, price) {
  const rows = evaluate(snap, price), votes = rows.filter((x) => !x.neutral);
  const bull = votes.filter((x) => x.s > 0.15).length, bear = votes.filter((x) => x.s < -0.15).length;
  const lead = bull > bear ? ["g", "الأغلبية صاعدة"] : bear > bull ? ["r", "الأغلبية هابطة"] : ["m", "لا يوجد اتجاه واضح"];
  const cards = rows.map((x) => {
    const cls = x.w ? "a" : x.neutral || x.nc || Math.abs(x.s) <= 0.15 ? "m" : x.s > 0 ? "g" : "r";
    const len = Math.abs(x.s) * 50, col = x.s > 0 ? "var(--green)" : "var(--red)";
    const bar = x.neutral ? "" : `<i style="left:${x.s > 0 ? 50 : 50 - len}%;width:${len}%;background:${col}"></i>`;
    return `<div class="ind"><div class="top2"><span class="nm">${esc(x.n)}</span><span class="vd ${cls}">${esc(x.d)}</span></div>
      <div class="val">${esc(x.v)}</div><div class="bar">${bar}</div></div>`;
  }).join("");
  return `<div class="board-sum"><span class="${lead[0]}">● ${lead[1]}</span> &nbsp;
    <span class="g">صاعد ${AR(bull)}</span> / <span class="r">هابط ${AR(bear)}</span> / <span class="m">محايد ${AR(votes.length - bull - bear)}</span></div>
    <div class="board">${cards}</div>`;
}

// ------------------------------------------------------------------ chart (canvas)
function drawChart(canvas, candles, snap, tf, marker) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  const n = Math.min(70, candles.length), cs = candles.slice(-n), se = snap.series;
  const tail = (a) => a.slice(-n);          // indicator series end at the same last candle as `candles`
  const lines = { e9: tail(se.e9), e21: tail(se.e21), e50: tail(se.e50), bu: tail(se.bbU), bl: tail(se.bbL), st: tail(se.st), sd: tail(se.stDir) };
  let lo = Math.min(...cs.map((c) => c.low)), hi = Math.max(...cs.map((c) => c.high));
  for (const a of [lines.bu, lines.bl]) for (const v of a) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const padR = 56, cw = (W - padR - 8) / n, y = (v) => 8 + (H - 16) * (1 - (v - lo) / (hi - lo)), x = (i) => 8 + cw * (i + 0.5);
  g.strokeStyle = "#1f2838"; g.lineWidth = 1; g.fillStyle = "#8a94a8"; g.font = "10px ui-monospace, Menlo, monospace";
  for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4, yy = y(v); g.beginPath(); g.moveTo(0, yy); g.lineTo(W - padR, yy); g.stroke(); g.fillText(fmt(v), W - padR + 4, yy + 3); }
  for (const z of snap.zones) { g.fillStyle = z.kind === "support" ? "rgba(46,229,157,.10)" : "rgba(255,77,94,.10)"; g.fillRect(0, y(z.hi), W - padR, y(z.lo) - y(z.hi)); }
  const line = (a, col, dash = []) => { g.strokeStyle = col; g.setLineDash(dash); g.lineWidth = 1.3; g.beginPath(); let st = false;
    a.forEach((v, i) => { if (!Number.isFinite(v)) { st = false; return; } st ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); st = true; }); g.stroke(); g.setLineDash([]); };
  line(lines.bu, "#78909c", [4, 3]); line(lines.bl, "#78909c", [4, 3]);
  line(lines.e9, "#ffd54f"); line(lines.e21, "#4fc3f7"); line(lines.e50, "#ba68c8");
  line(lines.st.map((v, i) => (lines.sd[i] === 1 ? v : NaN)), "#00e676"); line(lines.st.map((v, i) => (lines.sd[i] === -1 ? v : NaN)), "#ff1744");
  cs.forEach((c, i) => { const up = c.close >= c.open; g.strokeStyle = g.fillStyle = up ? "#26a69a" : "#ef5350";
    g.beginPath(); g.moveTo(x(i), y(c.high)); g.lineTo(x(i), y(c.low)); g.stroke();
    const top = y(Math.max(c.open, c.close)); g.fillRect(x(i) - cw * 0.35, top, cw * 0.7, Math.max(1, y(Math.min(c.open, c.close)) - top)); });
  if (marker) { const xi = x(n - 1) + cw, yv = y(cs[n - 1].close); g.fillStyle = marker === "CALL" ? "#00e676" : "#ff1744";
    g.beginPath(); if (marker === "CALL") { g.moveTo(xi, yv + 6); g.lineTo(xi - 7, yv + 18); g.lineTo(xi + 7, yv + 18); } else { g.moveTo(xi, yv - 6); g.lineTo(xi - 7, yv - 18); g.lineTo(xi + 7, yv - 18); } g.fill(); }
}

// ------------------------------------------------------------------ views
const CAT = { fx: "عملات", metal: "معادن", crypto: "عملات رقمية", stock: "أسهم" };
const header = (step, title, sub, back) => `<div class="step">خطوة ${AR(step)}</div>
  <div class="title-row"><div><h1>${title}</h1><div class="sub mono">${esc(sub)}</div></div>
  ${back ? `<button class="back" data-act="back">→ رجوع</button>` : ""}</div>`;

function viewSignal() {
  const asset = ASSETS[S.source].find((a) => a.id === S.asset) || ASSETS[S.source][0];
  if (S.page === 0) {
    const rec = S.results.filter((r) => r.outcome !== "PENDING").slice(0, 5);
    return `${header(1, "اختر السوق", "اختر نوع السوق للتحليل", false)}
      <div class="markets">
        <button class="card market ${S.market === "REAL" ? "sel" : ""}" data-market="REAL"><div class="head"><span class="icon">📈</span><span class="badge live">LIVE</span></div>
          <div><b>السوق الحقيقي</b><div class="sub">عملات · ذهب · أسهم · كريبتو</div></div></button>
        <button class="card market ${S.market === "OTC" ? "sel" : ""}" data-market="OTC"><div class="head"><span class="icon">🌐</span><span class="badge otc">24/7</span></div>
          <div><b>OTC</b><div class="sub">سوق OTC</div></div></button>
      </div>
      <div class="card" style="margin-top:10px"><div class="k">〽 آخر النتائج الحقيقية (ربح وخسارة)</div>
        ${rec.length ? rec.map((r) => `<div class="row"><span class="${r.outcome === "WIN" ? "g" : r.outcome === "LOSS" ? "r" : "m"}">● ${{ WIN: "ربح", LOSS: "خسارة", PUSH: "تعادل" }[r.outcome]}</span>
          <span class="mono">${esc(r.asset)} ${tfLabel(r.tf)} ${r.dir === "CALL" ? "▲" : "▼"}${r.sim ? " SIM" : ""}</span></div>`).join("") : `<div class="note">لا توجد نتائج بعد</div>`}</div>`;
  }
  if (S.page === 1) {
    const tile = (s, l) => `<button class="card tile ${S.tf === s ? "sel" : ""}" data-tf="${s}"><span class="n">${s < 60 ? s : s / 60}<small>${s < 60 ? "s" : "m"}</small></span><span class="l">${l}</span></button>`;
    return `${header(2, "وقت الانتهاء", S.market === "OTC" ? "OTC" : "السوق الحقيقي", true)}
      <div class="section">ثواني</div><div class="tiles">${tile(5, "سريع")}${tile(10, "سريع")}${tile(15, "عاجل")}${tile(30, "SCALP")}</div>
      <div class="section">دقائق</div><div class="tiles">${tile(60, "قصير")}${tile(120, "قصير")}${tile(180, "متوسط")}${tile(300, "متوسط")}</div>
      <div class="tiles" style="grid-template-columns:repeat(3,1fr);margin-top:8px">${tile(600, "طويل")}${tile(900, "طويل")}${tile(1800, "طويل")}</div>`;
  }
  if (S.page === 2) {
    const opts = S.market === "OTC" ? ["EUR/USD OTC", "GBP/USD OTC", "الذهب OTC"].map((n) => `<option>${n}</option>`).join("")
      : ASSETS[S.source].map((a) => `<option value="${esc(a.id)}" ${a.id === S.asset ? "selected" : ""}>${esc(a.name)}</option>`).join("");
    return `${header(3, "مساحة العمل", S.market === "OTC" ? "OTC" : asset.name, true)}
      <div class="card"><div class="card"><div class="k">الزوج</div><select id="asset" class="v">${opts}</select></div>
        <div class="kv"><div class="card"><div class="k">الفئة</div><div class="v">${S.market === "OTC" ? "OTC" : CAT[asset.cat]}</div></div>
        <div class="card"><div class="k">الوقت</div><div class="v mono">${tfLabel(S.tf)}</div></div></div></div>
      <button class="get" data-act="get">⚡ احصل على إشارة</button>
      <div id="live"></div>`;
  }
  // page 3: analysis / result
  let body;
  if (S.market === "OTC") {
    body = `<div class="big">OTC</div><div class="info">لا توجد بيانات OTC موثّقة. البرنامج لا يولّد إشارات OTC من بيانات غير حقيقية، لأن بوكيت أوبشن لا توفر مصدراً رسمياً لأسعار OTC.</div>`;
  } else if (S.loading) {
    body = `<div class="radar"></div><div class="info">جارٍ تحميل بيانات ${esc(asset.name)}...</div>`;
  } else if (S.pending) {
    body = `<div class="radar"></div><div id="countdown" class="big wait mono">…</div>
      <div class="info">معالجة التقلبات وبنية الشموع لـ ${esc(asset.name)} - بانتظار إغلاق الشمعة الحالية</div>`;
  } else if (S.result?.err) {
    body = `<div class="big">⚠</div><div class="info">${esc(S.result.err)}</div>`;
  } else if (S.result) {
    const r = S.result;
    if (r.direction === "NONE") {
      body = `<div class="big">لا توجد إشارة قوية الآن - لا تدخل</div><div class="info">${r.reasons.map(esc).join(" · ")}${r.sim ? " · ⚠ محاكاة" : ""}</div>`;
    } else {
      body = `<div id="resbig" class="big ${r.direction === "CALL" ? "call" : "put"}">${r.direction === "CALL" ? "شراء ▲" : "بيع ▼"} · ${esc(asset.name)}</div>
        <div id="resinfo" class="info"></div>`;
    }
  }
  const again = !S.loading && !S.pending ? `<button class="get" data-act="get">↻ إشارة جديدة</button>` : "";
  return `${header(4, "حساب الرسوم البيانية", S.market === "OTC" ? "OTC" : asset.name, true)}${body}${again}<div id="live"></div>`;
}

function viewResults() {
  const done = S.results.filter((r) => r.outcome === "WIN" || r.outcome === "LOSS");
  const real = done.filter((r) => !r.sim);
  const w = real.filter((r) => r.outcome === "WIN").length, n = real.length, be = breakeven(S.payout);
  let ci = "", verdict = `نتائج غير كافية للحكم (${AR(n)}/٥٠)`;
  if (n) {
    const z = 1.96, p = w / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    const lo = (c - m) / d, hi = (c + m) / d; ci = `${(lo * 100).toFixed(0)}%–${(hi * 100).toFixed(0)}%`;
    if (n >= 50) verdict = lo > be ? "نسبة الربح أعلى من التعادل بثقة 95%" : hi < be ? "نسبة الربح أقل من التعادل - خاسر" : "لا توجد أفضلية مثبتة";
  }
  return `<div class="step">السجل</div><h1>النتائج</h1>
    <div class="card"><div class="stats"><div><b class="g">${AR(w)}</b>ربح</div><div><b class="r">${AR(n - w)}</b>خسارة</div>
      <div><b>${n ? ((w / n) * 100).toFixed(0) + "%" : "-"}</b>نسبة الربح</div></div>
      <div class="note" style="margin-top:8px">بيانات حقيقية فقط · نقطة التعادل ${(be * 100).toFixed(1)}% · ثقة 95%: ${ci || "-"}<br><b>${verdict}</b></div></div>
    <div class="card" style="margin-top:10px">${S.results.slice(0, 50).map((r) => `<div class="row">
      <span class="${r.outcome === "WIN" ? "g" : r.outcome === "LOSS" ? "r" : "m"}">● ${{ WIN: "ربح", LOSS: "خسارة", PUSH: "تعادل", PENDING: "قيد الانتظار" }[r.outcome]}</span>
      <span class="mono">${esc(r.asset)} ${tfLabel(r.tf)} ${r.dir === "CALL" ? "▲" : "▼"}${r.sim ? " SIM" : ""}</span>
      <span class="note mono">${new Date(r.entryOpen * 1000).toLocaleTimeString("en-GB")}</span></div>`).join("") || `<div class="note">لا توجد صفقات بعد</div>`}</div>
    ${S.results.length ? `<button class="btn2" style="margin-top:10px" data-act="clear">مسح السجل</button>` : ""}`;
}

function viewSettings() {
  const src = (v, t, d) => `<label class="opt"><input type="radio" name="src" value="${v}" ${S.source === v ? "checked" : ""}><span><b>${t}</b><br><span class="note">${d}</span></span></label>`;
  return `<div class="step">التهيئة</div><h1>الإعدادات</h1>
    <div class="card"><div class="k">مصدر البيانات</div>
      ${src("binance", "Binance", "عملات رقمية - أسعار حقيقية مجاناً بدون مفتاح")}
      ${src("twelvedata", "Twelve Data", "عملات، ذهب، فضة، أسهم - يحتاج مفتاح API")}
      ${src("simulation", "محاكاة", "أسعار تجريبية للتدريب فقط")}
      <div class="k" style="margin-top:8px">مفتاح Twelve Data (يُحفظ على هذا الجهاز فقط)</div>
      <input id="tdkey" type="password" autocomplete="off" placeholder="${S.tdKey ? "محفوظ - اكتب لاستبداله" : "الصق المفتاح هنا"}">
    </div>
    <div class="card" style="margin-top:10px"><div class="kv" style="margin:0">
      <div><div class="k">نسبة العائد</div><input id="payout" type="number" step="0.01" min="0.1" max="1" value="${S.payout}"></div>
      <div><div class="k">حد الدخول (من الشمعة)</div><input id="cutoff" type="number" step="0.05" min="0.1" max="1" value="${S.cutoff}"></div></div></div>
    <button class="get" data-act="save">حفظ وإعادة الاتصال</button>
    <div class="card" style="margin-top:10px"><div class="k">📱 التثبيت على الآيفون</div>
      <div class="note">افتح هذه الصفحة في Safari ← زر المشاركة ⬆️ ← «إضافة إلى الشاشة الرئيسية». على أندرويد: قائمة Chrome ⋮ ← «تثبيت التطبيق».</div></div>
    <div class="warn" style="margin-top:10px">إشارات فقط - لا ينفذ صفقات. البرنامج لا يحلل OTC لعدم وجود مصدر رسمي لأسعاره. نموذج الاحتمال غير معايَر بعد، لذلك أعلى جودة هي «متوسطة». الخيارات الثنائية عالية المخاطر.</div>`;
}

function render() {
  document.querySelectorAll("nav.bottom button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
  $("#view").innerHTML = (S.tab === "signal" ? viewSignal() : S.tab === "results" ? viewResults() : viewSettings())
    + `<div class="disc">الإشارات تقديرات إحصائية وليست ضمانات. الخيارات الثنائية عالية المخاطر.</div>`;
  liveTick();
  liveBoard();                                   // repaint indicators/chart immediately after any re-render
}

// periodic UI refresh: countdown, result timer, live indicators, pill, ticker
function liveTick() {
  if (!feed) { setPill(false); return; }
  const streaming = feed.builders.size > 0;     // before any pair is chosen there are no ticks yet
  setPill(feed.health.connected && (!streaming || now() - feed.health.lastTick < 6));
  const cd = $("#countdown");
  if (cd && S.pending) { const f = feed.forming(S.pending.asset, S.pending.tf); cd.textContent = f ? `${Math.max(0, f.ts + S.pending.tf - now()).toFixed(1)}s` : "…"; }
  const info = $("#resinfo");
  if (info && S.result && S.result.direction !== "NONE") {
    const left = S.result.deadline - now(), live = left > 0;
    $("#resbig").className = `big ${live ? (S.result.direction === "CALL" ? "call" : "put") : ""}`;
    info.innerHTML = `<b>${live ? `ادخل خلال ${left.toFixed(1)} ثانية` : "انتهت - لا تدخل"}</b> · المدة ${tfLabel(S.result.tf)} · جودة متوسطة · احتمال الربح ${(S.result.probability * 100).toFixed(1)}% (غير معايَر) · التعادل ${(S.result.breakeven * 100).toFixed(1)}%${S.result.sim ? " · ⚠ محاكاة" : ""}`;
  }
}

let lastLive = 0, boardBusy = false;
async function liveBoard() {
  if (boardBusy) return;
  boardBusy = true;
  try { await liveBoardInner(); } finally { boardBusy = false; lastLive = now(); }
}
async function liveBoardInner() {
  const el = $("#live");
  if (!el || S.market === "OTC" || !feed || S.tab !== "signal" || S.page < 2) {
    if (el && S.market === "OTC") el.innerHTML = `<div class="board-sum m">لا توجد أسعار OTC موثّقة لحساب المؤشرات</div>`;
    return;
  }
  try { await feed.ensure(S.asset, S.tf); } catch (e) { el.innerHTML = `<div class="info">${esc(e.message)}</div>`; return; }
  const cs = feed.candles(S.asset, S.tf);
  if (cs.length < 60) { el.innerHTML = `<div class="board-sum m">بانتظار بيانات كافية (${AR(cs.length)}/٦٠)</div>`; return; }
  const snap = compute(cs), price = feed.lastPrice(S.asset) ?? cs[cs.length - 1].close;
  el.innerHTML = `<div class="section">📊 لوحة المؤشرات · ${esc(S.asset)} · ${tfLabel(S.tf)}</div>${boardHTML(snap, price)}<canvas class="chart"></canvas>`;
  const marker = S.result && S.result.asset === S.asset && S.result.tf === S.tf && S.result.direction !== "NONE" ? S.result.direction : null;
  drawChart($("canvas.chart", el), cs, snap, S.tf, marker);
}

function setPill(ok) {
  const p = $("#pill"); p.className = `pill ${ok ? "on" : "off"}`;
  p.textContent = `● ${ok ? "متصل" : "غير متصل"}${feed ? " · " + feed.source : ""}`;
}

function refreshTicker() {
  if (!feed) return;
  const parts = ASSETS[S.source].filter((a) => feed.lastPrice(a.id) !== undefined).map((a) => {
    const p = feed.lastPrice(a.id), tf = [...feed.builders.keys()].find((k) => k.startsWith(a.id + "|"))?.split("|")[1];
    const cs = tf ? feed.candles(a.id, +tf) : [], ref = cs.length ? cs[Math.max(0, cs.length - 120)].close : p, ch = ((p - ref) / ref) * 100;
    return `${a.name.replace(/[^\x20-\x7E]/g, "").trim()} ${fmt(p)} ${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch).toFixed(2)}%`;
  });
  const t = $("#ticker-track"), txt = parts.join("     ");
  if (t.textContent !== txt) t.textContent = txt;
}

// ------------------------------------------------------------------ events
document.addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.tab) { S.tab = b.dataset.tab; render(); return; }
  if (b.dataset.market) { S.market = b.dataset.market; S.page = 1; render(); return; }
  if (b.dataset.tf) { S.tf = +b.dataset.tf; S.page = 2; S.result = null; render(); liveBoard(); return; }
  const act = b.dataset.act;
  if (act === "back") { S.page = Math.max(0, S.page - 1); S.pending = null; render(); liveBoard(); }
  else if (act === "get") requestSignal().then(liveBoard);
  else if (act === "clear") { if (confirm("مسح كل النتائج؟")) { S.results = []; store.set("results", []); render(); } }
  else if (act === "save") {
    const src = document.querySelector("input[name=src]:checked")?.value || S.source, key = $("#tdkey").value.trim();
    if (key) { S.tdKey = key; store.set("tdKey", key); }
    S.payout = Math.min(1, Math.max(0.1, +$("#payout").value || 0.85)); S.cutoff = Math.min(1, Math.max(0.1, +$("#cutoff").value || 0.5));
    store.set("payout", S.payout); store.set("cutoff", S.cutoff);
    S.source = src; store.set("source", src); startFeed(); S.tab = "signal"; S.page = 0; render();
  }
});
document.addEventListener("change", (e) => { if (e.target.id === "asset" && S.market !== "OTC") { S.asset = e.target.value; S.result = null; liveBoard(); } });

startFeed(); render();
setInterval(liveTick, 200);
setInterval(refreshTicker, 1500);
setInterval(() => { if (now() - lastLive > 1) { lastLive = now(); liveBoard(); } }, 1000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
