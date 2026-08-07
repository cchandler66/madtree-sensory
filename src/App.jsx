import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

/* ============================================================================
   LINE CHECK — MadTree Oakley draft sensory program
   Cloud-synced via Firebase. Includes Data Tracking & Batch Tracking.
   ========================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCncjKiliby4dqoDLG8bft-CNum9Xac0tY",
  authDomain: "draft-beer-72e25.firebaseapp.com",
  projectId: "draft-beer-72e25",
  storageBucket: "draft-beer-72e25.firebasestorage.app",
  messagingSenderId: "887136359517",
  appId: "1:887136359517:web:d0dd56aa9654edb6eda9b4",
  measurementId: "G-9SWG68F7ET"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const K_CORE = "linecheck:core:v1";
const K_RES = (ym) => `linecheck:res:${ym}`;

/* ---------------------------------------------------------------- constants */

const STYLE_ORDER = ["Non Beer", "Light & Crisp", "Fruity", "Hoppy", "Malty", "Barrel Aged", "Cocktail"];

const PALATE_RANK = {
  "Non Beer": 1, "Light & Crisp": 2, "Malty": 4, "Fruity": 5, "Hoppy": 6, "Cocktail": 7, "Barrel Aged": 8,
};

const FLIGHTS = [
  { id: "A", day: "Mon", label: "Flight A", groups: ["Non Beer", "Light & Crisp"], note: "Lagers show every fault. First and cleanest palate of the week." },
  { id: "B", day: "Wed", label: "Flight B", groups: ["Hoppy"], note: "Hop aroma fades fastest. Midweek catches the weekend's damage." },
  { id: "C", day: "Fri", label: "Flight C", groups: ["Malty", "Fruity", "Cocktail", "Barrel Aged"], note: "Palate-coating and adjunct beers go last in the week." },
];

const TTB = [
  { v: "yes", label: "True", hint: "In spec. Would serve." },
  { v: "marginal", label: "Marginal", hint: "Drifting. Recheck next session." },
  { v: "no", label: "Not true", hint: "Out of spec. Do not serve." },
];

const HEDONIC_ANCHORS = {
  1: "Dislike extremely", 2: "Dislike very much", 3: "Dislike moderately",
  4: "Dislike slightly", 5: "Neither", 6: "Like slightly",
  7: "Like moderately", 8: "Like very much", 9: "Like extremely",
};

const MODALITIES = ["Appearance", "Aroma", "Flavor", "Mouthfeel", "Finish"];

const FAULTS = [
  { id: "papery", label: "Papery / cardboard", origin: "B", cause: "Oxidation. Check packaging DO, keg headspace, age." },
  { id: "sherry", label: "Sherry / stale toffee", origin: "B", cause: "Advanced staling. Usually age + warm storage." },
  { id: "hopfade", label: "Hop aroma faded", origin: "B", cause: "Age. Compare to days-since-package curve." },
  { id: "acetald", label: "Acetaldehyde (green apple)", origin: "B", cause: "Young beer, rushed conditioning, or oxidation of ethanol." },
  { id: "diacetyl", label: "Diacetyl (butter, slick)", origin: "BL", cause: "Incomplete VDK rest, OR Pediococcus biofilm in the line." },
  { id: "dms", label: "DMS (cooked corn)", origin: "B", cause: "Boil vigor, whirlpool stand, or wort infection." },
  { id: "sulfur", label: "Sulfur / struck match", origin: "B", cause: "Yeast stress or young lager. Often blows off." },
  { id: "phenol", label: "Band-aid / medicinal", origin: "BL", cause: "Wild yeast, OR chlorinated sanitizer left in the line." },
  { id: "acetic", label: "Vinegar / acetic", origin: "L", cause: "Acetobacter. Air in the line or a dirty faucet." },
  { id: "lactic", label: "Sour / yogurt / lactic", origin: "L", cause: "Lactobacillus or Pediococcus biofilm." },
  { id: "moldy", label: "Moldy / musty / earthy", origin: "L", cause: "Mold in the faucet, FOB, or drip tray splash-back." },
  { id: "metallic", label: "Metallic / blood", origin: "L", cause: "Beer stone, corroded coupler, or worn shank." },
];

const ACTIONS = [
  { v: "pass", label: "Pass", tone: "good" },
  { v: "watch", label: "Watch", tone: "warn" },
  { v: "pull_line", label: "Pull + clean line", tone: "bad" },
  { v: "pull_keg", label: "Pull keg", tone: "bad" },
];

const DEFAULT_SETTINGS = {
  likingPass: 6.5, likingWatch: 5.5, faultInvestigate: 3, faultPull: 4,
  defaultShelfDays: 120, coverageDays: 7,
};

const SEED_TASTERS = [
  { id: "t1", name: "Quality Manager", short: "QM", status: "trained" },
  { id: "t2", name: "Head Brewer", short: "HB", status: "trained" },
];

const SEED_TAPS = [
  { line: 1, brand: "MadTree Light Lager", style: "Light & Crisp", pkg: "", dlScore: "7.2", shelf: 120, onDeck: false },
  { line: 10, brand: "Psychopathy", style: "Hoppy", pkg: "", dlScore: "7.8", shelf: 120, onDeck: false },
  { line: 0, brand: "High 5", style: "Hoppy", pkg: "", dlScore: "7.5", shelf: 120, onDeck: true },
].map((t, i) => ({ id: `tap${i + 1}`, active: true, notes: "", ...t }));

/* ---------------------------------------------------------------- utilities */

const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const ymOf = (iso) => (iso || todayISO()).slice(0, 7);

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
}
const daysSince = (iso) => (iso ? daysBetween(iso, todayISO()) : null);
function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

function ols(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const mx = mean(pts.map((p) => p.x));
  const my = mean(pts.map((p) => p.y));
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : 0, n };
}

function freshness(tap) {
  const shelf = tap.shelf || DEFAULT_SETTINGS.defaultShelfDays;
  const age = daysSince(tap.pkg);
  if (age === null) return { age: null, shelf, frac: null, left: null, state: "unknown" };
  const frac = age / shelf;
  const state = frac >= 1 ? "expired" : frac >= 0.75 ? "code-risk" : frac >= 0.5 ? "mature" : "fresh";
  return { age, shelf, frac, left: shelf - age, state };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function download(name, text, type = "text/csv") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------------------------------------ storage layer */
async function sGet(key) {
  try {
    const snap = await getDoc(doc(db, "linecheck", key));
    return snap.exists() ? JSON.parse(snap.data().value) : null;
  } catch (e) {
    console.error("Firebase Read Error:", e);
    return null;
  }
}

async function sSet(key, value) {
  try {
    await setDoc(doc(db, "linecheck", key), { value: JSON.stringify(value) });
    return true;
  } catch (e) {
    console.error("Firebase Write Error:", e);
    return false;
  }
}

/* ------------------------------------------------------------------- styles */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
.lc { --ink:#0E1116; --panel:#161B22; --panel2:#1D242E; --edge:#2A323D; --foam:#F4F1E8; --muted:#8A94A3; --dim:#5D6673; --amber:#E9A13B; --green:#3FB27F; --red:#E0574A; --blue:#5B9DD9; --violet:#9B8CD4; --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace; --sans:'Archivo',system-ui,-apple-system,sans-serif; background:var(--ink); color:var(--foam); font-family:var(--sans); min-height:100vh; font-size:15px; line-height:1.45; -webkit-font-smoothing:antialiased; }
.lc *,.lc *::before,.lc *::after{box-sizing:border-box} .lc button{font:inherit;color:inherit;background:none;border:none;cursor:pointer} .lc input,.lc select,.lc textarea{font:inherit;color:var(--foam);background:var(--ink); border:1px solid var(--edge);border-radius:6px;padding:7px 9px;width:100%} .lc input:focus,.lc select:focus{outline:2px solid var(--amber);outline-offset:1px} .lc-mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.lc-wrap{max-width:1180px;margin:0 auto;padding:0 18px 90px} .lc-top{position:sticky;top:0;z-index:30;background:rgba(14,17,22,.94); backdrop-filter:blur(10px);border-bottom:1px solid var(--edge);margin:0 -18px 20px;padding:12px 18px} .lc-topin{max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap} .lc-mark{display:flex;align-items:baseline;gap:9px} .lc-mark b{font-size:17px;font-weight:800;letter-spacing:-.02em} .lc-nav{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap} .lc-nav button{font-family:var(--mono);font-size:11px;text-transform:uppercase; letter-spacing:.1em;padding:7px 11px;border-radius:5px;color:var(--muted)} .lc-nav button:hover{color:var(--foam);background:var(--panel)} .lc-nav button[data-on="1"]{background:var(--panel2);color:var(--amber)}
.lc-h{font-size:13px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.13em; color:var(--muted);margin:0 0 10px;display:flex;align-items:center;gap:9px} .lc-h::after{content:"";flex:1;height:1px;background:var(--edge)} .lc-lede{color:var(--muted);font-size:13.5px;max-width:66ch;margin:0 0 16px} .lc-sec{margin:26px 0} .lc-k{font-family:var(--mono);font-size:10px;text-transform:uppercase; letter-spacing:.11em;color:var(--dim)}
.lc-card{background:var(--panel);border:1px solid var(--edge);border-radius:9px;padding:14px} .lc-grid{display:grid;gap:10px} .lc-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cc{position:relative;height:7px;background:var(--ink);border-radius:4px;overflow:hidden; border:1px solid var(--edge)} .cc i{position:absolute;inset:0 auto 0 0;display:block;border-radius:3px} .cc-lab{display:flex;justify-content:space-between;font-family:var(--mono); font-size:9.5px;color:var(--dim);margin-top:5px;letter-spacing:.05em}
.tap{background:var(--panel);border:1px solid var(--edge);border-left:3px solid var(--dim); border-radius:8px;padding:11px 13px;display:grid;gap:9px;} .tap[data-s="good"]{border-left-color:var(--green)} .tap[data-s="warn"]{border-left-color:var(--amber)} .tap[data-s="bad"]{border-left-color:var(--red)} .tap[data-s="none"]{border-left-color:var(--edge)} .tap-head{display:flex;align-items:flex-start;gap:10px} .tap-line{font-family:var(--mono);font-size:19px;font-weight:600;color:var(--dim); min-width:30px;line-height:1} .tap-name{font-weight:600;font-size:14.5px;letter-spacing:-.01em;line-height:1.25} .tap-sub{font-family:var(--mono);font-size:10px;color:var(--dim); text-transform:uppercase;letter-spacing:.08em;margin-top:3px} .tap-score{margin-left:auto;text-align:right;font-family:var(--mono);line-height:1.1} .tap-score b{font-size:20px;font-weight:600;display:block} .tap-score span{font-size:9px;color:var(--dim);text-transform:uppercase;letter-spacing:.09em}
.chip{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em; padding:3px 7px;border-radius:4px;border:1px solid var(--edge);color:var(--muted); display:inline-flex;align-items:center;gap:5px;white-space:nowrap} .chip[data-t="good"]{color:var(--green);border-color:#245741} .chip[data-t="warn"]{color:var(--amber);border-color:#5C4520} .chip[data-t="bad"]{color:var(--red);border-color:#5E2A25} .chip[data-t="info"]{color:var(--blue);border-color:#254157} .chip[data-t="line"]{color:var(--violet);border-color:#3E3760}
.btn{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.1em; padding:9px 14px;border-radius:6px;border:1px solid var(--edge);background:var(--panel2); color:var(--foam);transition:.13s} .btn:hover{border-color:var(--muted)} .btn[data-p="1"]{background:var(--amber);color:#17140C;border-color:var(--amber);font-weight:600} .btn[data-ghost="1"]{background:none;color:var(--muted)} .btn:disabled{opacity:.35;cursor:not-allowed} .btn-sm{padding:5px 9px;font-size:10px}
.opts{display:grid;gap:7px} .opts-3{grid-template-columns:repeat(3,1fr)} .opt{border:1px solid var(--edge);border-radius:8px;padding:13px 10px;text-align:center; background:var(--panel);} .opt b{display:block;font-size:14px;font-weight:600} .opt small{display:block;font-size:10.5px;color:var(--dim);margin-top:3px;line-height:1.3} .opt[data-on="1"][data-t="good"]{background:#12271E;border-color:var(--green);color:var(--green)} .opt[data-on="1"][data-t="warn"]{background:#2A2113;border-color:var(--amber);color:var(--amber)} .opt[data-on="1"][data-t="bad"]{background:#2B1614;border-color:var(--red);color:var(--red)}
.hed{display:grid;grid-template-columns:repeat(9,1fr);gap:5px} .hed button{aspect-ratio:1;border:1px solid var(--edge);border-radius:7px;background:var(--panel); font-family:var(--mono);font-size:16px;font-weight:600;} .hed button[data-on="1"]{background:var(--amber);color:#17140C;border-color:var(--amber)} .hed-lab{display:flex;justify-content:space-between;font-family:var(--mono);font-size:9.5px; color:var(--dim);margin-top:6px;text-transform:uppercase;letter-spacing:.07em}
.fchips{display:flex;flex-wrap:wrap;gap:6px} .fchip{border:1px solid var(--edge);border-radius:6px;padding:6px 9px;font-size:12px; background:var(--panel);display:inline-flex;align-items:center;gap:7px;} .fchip[data-on="1"]{border-color:var(--red);background:#241514;color:#F1978B} .fint{display:flex;gap:4px;align-items:center;margin-left:2px} .fint button{width:19px;height:19px;border-radius:4px;border:1px solid var(--edge); font-family:var(--mono);font-size:10px;display:flex;align-items:center;justify-content:center} .fint button[data-on="1"]{background:var(--red);border-color:var(--red);color:#fff}
.tbl{width:100%;border-collapse:collapse;font-size:13px} .tbl th{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.1em; color:var(--dim);text-align:left;padding:7px 9px;border-bottom:1px solid var(--edge);font-weight:500} .tbl td{padding:8px 9px;border-bottom:1px solid #1E252E;vertical-align:middle} .tbl-wrap{overflow-x:auto;border:1px solid var(--edge);border-radius:9px;background:var(--panel)} .tbl td.n{font-family:var(--mono);font-variant-numeric:tabular-nums}
.alert{border:1px solid var(--edge);border-left:3px solid var(--amber);border-radius:7px; padding:11px 13px;background:var(--panel);display:flex;gap:11px;align-items:flex-start} .alert[data-t="bad"]{border-left-color:var(--red)} .alert-b{font-weight:600;font-size:13.5px;margin-bottom:2px} .alert-d{font-size:12.5px;color:var(--muted);line-height:1.45}
.rail{display:flex;gap:3px;margin:14px 0} .rail i{flex:1;height:3px;background:var(--edge);border-radius:2px} .rail i[data-on="1"]{background:var(--amber)} .rail i[data-on="2"]{background:var(--green)}
.mut{color:var(--muted)}.dim{color:var(--dim)} .stack{display:grid;gap:14px} .hr{height:1px;background:var(--edge);margin:16px 0;border:0}
`;

/* ---------------------------------------------------------------- analytics */
function analyze(taps, results, settings) {
  const tapById = Object.fromEntries(taps.map((t) => [t.id, t]));
  const byBrand = {};
  const byLine = {};
  const byTaster = {};
  const faultCount = {};

  for (const r of results) {
    const tap = tapById[r.tapId];
    if (!tap) continue;
    (byBrand[tap.brand] ||= []).push(r);
    (byLine[tap.line] ||= []).push(r);
    (byTaster[r.tasterId] ||= []).push(r);
    for (const f of r.faults || []) {
      const k = f.id;
      faultCount[k] ||= { id: k, n: 0, sumI: 0, taps: new Set(), sessions: new Set(), rows: [] };
      faultCount[k].n++;
      faultCount[k].sumI += f.i;
      faultCount[k].taps.add(r.tapId);
      faultCount[k].rows.push(r);
      faultCount[k].sessions.add(r.sessionId);
    }
  }

  const tapStats = taps.map((t) => {
    // Current batch tracking: only look at scores where the package date matches the active tap setup
    const rs = results.filter((r) => r.tapId === t.id && r.pkg === t.pkg).sort((a, b) => b.date.localeCompare(a.date));
    const likes = rs.map((r) => r.liking).filter((x) => typeof x === "number");
    const last = rs[0];
    const lastDate = last ? last.date : null;
    const lastSession = last ? rs.filter((r) => r.sessionId === last.sessionId) : [];
    const lastMean = lastSession.length ? mean(lastSession.map((r) => r.liking)) : null;
    
    let status = "none";
    if (lastMean !== null) {
      if (lastMean < settings.likingWatch) status = "bad";
      else if (lastMean < settings.likingPass) status = "warn";
      else status = "good";
    }
    
    const fr = freshness(t);
    const sinceCheck = lastDate ? daysSince(lastDate) : null;
    
    return {
      tap: t, rs, n: rs.length, lastDate, sinceCheck, lastMean, status, fresh: fr,
      allSd: sd(likes),
      ttbFail: rs.length ? rs.filter((r) => r.ttb === "no").length / rs.length : null,
    };
  });

  const active = taps.filter((t) => t.active && !t.onDeck);
  const covered = tapStats.filter((s) => s.tap.active && !s.tap.onDeck && s.sinceCheck !== null && s.sinceCheck <= settings.coverageDays);
  const coverage = active.length ? covered.length / active.length : 0;
  const houseMean = mean(results.map(r => r.liking).filter(Boolean));

  // Data Tracking: Brand freshness curves
  const brandCurves = Object.entries(byBrand).map(([brand, rs]) => {
    const pts = rs
      .filter((r) => typeof r.ageDays === "number" && typeof r.liking === "number")
      .map((r) => ({ x: r.ageDays, y: r.liking }));
    const fit = ols(pts);
    let crossDays = null;
    if (fit && fit.slope < -0.002) {
      crossDays = Math.round((settings.likingPass - fit.intercept) / fit.slope);
      if (crossDays < 0 || crossDays > 900) crossDays = null;
    }
    return { brand, pts, fit, crossDays, n: pts.length };
  }).sort((a, b) => b.n - a.n);

  // Data Tracking: Line report card
  const lineStats = Object.entries(byLine).map(([line, rs]) => {
    const likes = rs.map((r) => r.liking).filter((x) => typeof x === "number");
    const brands = new Set(rs.map((r) => tapById[r.tapId]?.brand));
    const lineFaults = rs.flatMap((r) => (r.faults || []).filter((f) => {
      const def = FAULTS.find((d) => d.id === f.id);
      return def && (def.origin === "L" || def.origin === "BL");
    }));
    return {
      line: Number(line), n: likes.length, brands: brands.size,
      mean: mean(likes), delta: houseMean !== null && likes.length ? mean(likes) - houseMean : null,
      lineFaults: lineFaults.length,
      suspect: likes.length >= 5 && brands.size >= 2 && houseMean !== null && mean(likes) - houseMean <= -0.8,
    };
  }).sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));

  // Data Tracking: Taster stats
  const cell = {};
  for (const r of results) {
    const k = `${r.sessionId}|${r.tapId}`;
    (cell[k] ||= []).push(r);
  }
  const tasterStats = Object.entries(byTaster).map(([tasterId, rs]) => {
    const likes = rs.map((r) => r.liking).filter((x) => typeof x === "number");
    const deltas = rs.map((r) => {
      const peers = (cell[`${r.sessionId}|${r.tapId}`] || [])
        .filter((p) => p.tasterId !== tasterId && typeof p.liking === "number");
      if (!peers.length) return null;
      return r.liking - mean(peers.map((p) => p.liking));
    }).filter((x) => x !== null);
    return {
      tasterId, n: likes.length, mean: mean(likes), sd: sd(likes),
      bias: mean(deltas), severity: mean(deltas) === null ? null
        : mean(deltas) > 0.35 ? "lenient" : mean(deltas) < -0.35 ? "severe" : "aligned",
      notTrueRate: rs.length ? rs.filter((r) => r.ttb === "no").length / rs.length : null,
    };
  });

  const pareto = Object.values(faultCount).map((f) => {
    const def = FAULTS.find((d) => d.id === f.id);
    return { ...f, def, taps: f.taps.size, avgI: f.sumI / f.n, weight: f.sumI };
  }).sort((a, b) => b.weight - a.weight);

  return { tapStats, coverage, houseMean, brandCurves, lineStats, tasterStats, pareto, tapById };
}

/* -------------------------------------------------------------- primitives */
function CodeClock({ tap }) {
  const f = freshness(tap);
  if (f.frac === null) {
    return (
      <div>
        <div className="cc"><i style={{ width: "100%", background: "#1E252E" }} /></div>
        <div className="cc-lab"><span>no package date</span><span>{f.shelf}d shelf</span></div>
      </div>
    );
  }
  const pct = Math.min(100, f.frac * 100);
  const color = f.state === "expired" ? "var(--red)" : f.state === "code-risk" ? "var(--amber)" : "var(--green)";
  return (
    <div>
      <div className="cc" title={`${f.age} of ${f.shelf} days`}>
        <i style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="cc-lab">
        <span>{fmtDate(tap.pkg)} · day {f.age}</span>
        <span style={{ color }}>{f.left >= 0 ? `${f.left}d to code` : `${-f.left}d past`}</span>
      </div>
    </div>
  );
}

function Scatter({ curve, settings }) {
  const W = 360, H = 150, P = { l: 26, r: 8, t: 8, b: 20 };
  const pts = curve.pts;
  if (!pts.length) return null;
  const maxX = Math.max(...pts.map((p) => p.x), curve.crossDays || 0, 30) * 1.05;
  const x = (v) => P.l + (v / maxX) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - 1) / 8) * (H - P.t - P.b);
  const fit = curve.fit;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img">
      {[1, 3, 5, 7, 9].map((g) => (
        <g key={g}>
          <line x1={P.l} x2={W - P.r} y1={y(g)} y2={y(g)} stroke="#232B35" strokeWidth="1" />
          <text x={P.l - 5} y={y(g) + 3} fill="#5D6673" fontSize="8" fontFamily="IBM Plex Mono, monospace" textAnchor="end">{g}</text>
        </g>
      ))}
      <line x1={P.l} x2={W - P.r} y1={y(settings.likingPass)} y2={y(settings.likingPass)} stroke="#E9A13B" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
      {fit && (
        <line x1={x(0)} y1={y(Math.max(1, Math.min(9, fit.intercept)))}
          x2={x(maxX)} y2={y(Math.max(1, Math.min(9, fit.intercept + fit.slope * maxX)))} stroke="#5B9DD9" strokeWidth="1.5" />
      )}
      {curve.crossDays && curve.crossDays <= maxX && (
        <line x1={x(curve.crossDays)} x2={x(curve.crossDays)} y1={P.t} y2={H - P.b} stroke="#E0574A" strokeWidth="1" strokeDasharray="2 3" />
      )}
      {pts.map((p, i) => <circle key={i} cx={x(p.x)} cy={y(p.y)} r="3" fill="#F4F1E8" opacity="0.75" />)}
      <text x={W - P.r} y={H - 5} fill="#5D6673" fontSize="8" fontFamily="IBM Plex Mono, monospace" textAnchor="end">days since package →</text>
    </svg>
  );
}

/* ------------------------------------------------------------------- screens */
function Board({ a, settings, onGo }) {
  const rows = a.tapStats.filter((s) => s.tap.active && !s.tap.onDeck).sort((x, y) => x.tap.line - y.tap.line);
  const due = rows.filter((s) => s.sinceCheck === null || s.sinceCheck > settings.coverageDays);

  return (
    <div>
      <div className="lc-row" style={{ marginBottom: 18, gap: 22 }}>
        <div>
          <div className="lc-k">7-day coverage</div>
          <div className="lc-mono" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1 }}>
            {Math.round(a.coverage * 100)}<span style={{ fontSize: 15, color: "var(--dim)" }}>%</span>
          </div>
        </div>
        <div>
          <div className="lc-k">Taps due</div>
          <div className="lc-mono" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1, color: due.length ? "var(--amber)" : "var(--green)" }}>
            {due.length}
          </div>
        </div>
        <div>
          <div className="lc-k">House mean liking</div>
          <div className="lc-mono" style={{ fontSize: 30, fontWeight: 600, lineHeight: 1.1 }}>
            {a.houseMean === null ? "—" : a.houseMean.toFixed(2)}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn" data-p="1" onClick={onGo}>Start a Tasting Session</button>
        </div>
      </div>

      <div className="lc-sec">
        <div className="lc-h">Tap Wall (Active)</div>
        <div className="lc-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))" }}>
          {rows.map((s) => (
            <div className="tap" data-s={s.status} key={s.tap.id}>
              <div className="tap-head">
                <div className="tap-line lc-mono">{String(s.tap.line).padStart(2, "0")}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="tap-name">{s.tap.brand}</div>
                  <div className="tap-sub">{s.tap.style} {s.tap.dlScore && `· DL: ${s.tap.dlScore}`}</div>
                </div>
                <div className="tap-score">
                  <b style={{ color: s.lastMean === null ? "var(--dim)" : s.status === "bad" ? "var(--red)" : s.status === "warn" ? "var(--amber)" : "var(--green)" }}>
                    {s.lastMean === null ? "—" : s.lastMean.toFixed(1)}
                  </b>
                  <span>{s.sinceCheck === null ? "New Batch" : s.sinceCheck === 0 ? "today" : `${s.sinceCheck}d ago`}</span>
                </div>
              </div>
              <CodeClock tap={s.tap} />
              <div className="lc-row" style={{ gap: 5 }}>
                {s.n > 0 && <span className="chip">n={s.n}</span>}
                {s.allSd !== null && <span className="chip">sd {s.allSd.toFixed(2)}</span>}
                {s.ttbFail > 0 && <span className="chip" data-t="bad">{Math.round(s.ttbFail * 100)}% not true</span>}
                {(s.sinceCheck === null || s.sinceCheck > settings.coverageDays) && <span className="chip" data-t="warn">due</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function buildPlan(flightId, taps, a, customIds) {
  let pool;
  if (flightId === "custom") pool = taps.filter((t) => t.active && !t.onDeck && customIds.includes(t.id));
  else {
    const f = FLIGHTS.find((x) => x.id === flightId);
    pool = taps.filter((t) => t.active && !t.onDeck && f.groups.includes(t.style));
  }
  const sorted = pool.slice().sort((x, y) => (PALATE_RANK[x.style] ?? 5) - (PALATE_RANK[y.style] ?? 5) || x.line - y.line);
  return { flightId, samples: sorted.map((t) => ({ tapId: t.id })) };
}

const emptyDraft = () => ({ ttb: null, modalities: [], liking: null, faults: [], action: null, note: "" });

function TasteCard({ tap, taster, draft, set, onSubmit, idx, total, elapsed }) {
  const toggleFault = (id) => {
    const has = draft.faults.find((f) => f.id === id);
    set({ ...draft, faults: has ? draft.faults.filter((f) => f.id !== id) : [...draft.faults, { id, i: 2 }] });
  };
  const setInt = (id, i) => set({ ...draft, faults: draft.faults.map((f) => (f.id === id ? { ...f, i } : f)) });
  const ready = draft.ttb && draft.liking && draft.action;

  return (
    <div className="stack">
      <div className="lc-row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div className="lc-k">Sample {idx + 1} of {total} · scoring as {taster.name}</div>
          <div className="lc-mono" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1.05 }}>{tap.brand}</div>
          <div className="dim" style={{ fontSize: 13 }}>
            Line {tap.line} · {tap.style} {tap.dlScore && <span style={{ color: "var(--amber)" }}>· DL Release Score: {tap.dlScore}</span>}
          </div>
        </div>
        <div className="lc-mono dim" style={{ fontSize: 12 }}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</div>
      </div>

      <div>
        <div className="lc-k" style={{ marginBottom: 6 }}>1 · True to brand</div>
        <div className="opts opts-3">
          {TTB.map((o) => (
            <button key={o.v} className="opt" data-on={draft.ttb === o.v ? "1" : "0"} data-t={o.v === "yes" ? "good" : o.v === "marginal" ? "warn" : "bad"}
              onClick={() => set({ ...draft, ttb: o.v, modalities: o.v === "yes" ? [] : draft.modalities })}>
              <b>{o.label}</b><small>{o.hint}</small>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="lc-k" style={{ marginBottom: 6 }}>2 · Overall liking</div>
        <div className="hed">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <button key={n} data-on={draft.liking === n ? "1" : "0"} onClick={() => set({ ...draft, liking: n })}>{n}</button>
          ))}
        </div>
        <div className="hed-lab"><span>dislike extremely</span><span>{draft.liking ? HEDONIC_ANCHORS[draft.liking] : "neither"}</span><span>like extremely</span></div>
      </div>

      <div>
        <div className="lc-k" style={{ marginBottom: 6 }}>3 · Off-Flavors (Optional)</div>
        <div className="fchips">
          {FAULTS.map((f) => {
            const sel = draft.faults.find((x) => x.id === f.id);
            return (
              <span key={f.id} style={{ display: "inline-flex", alignItems: "center" }}>
                <button className="fchip" data-on={sel ? "1" : "0"} onClick={() => toggleFault(f.id)}>{f.label}</button>
                {sel && (
                  <span className="fint">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <button key={i} data-on={sel.i === i ? "1" : "0"} onClick={() => setInt(f.id, i)}>{i}</button>
                    ))}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>

      <div>
        <div className="lc-k" style={{ marginBottom: 6 }}>4 · Call it</div>
        <div className="opts" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
          {ACTIONS.map((o) => (
            <button key={o.v} className="opt" data-on={draft.action === o.v ? "1" : "0"} data-t={o.tone} onClick={() => set({ ...draft, action: o.v })} style={{ padding: "10px 6px" }}>
              <b style={{ fontSize: 12.5 }}>{o.label}</b>
            </button>
          ))}
        </div>
      </div>

      <input placeholder="Note (optional)" value={draft.note} onChange={(e) => set({ ...draft, note: e.target.value })} />
      <button className="btn" data-p="1" disabled={!ready} onClick={onSubmit} style={{ padding: "13px" }}>
        {ready ? "Submit and pour the next one" : "True to brand, liking, and a call are required"}
      </button>
    </div>
  );
}

function Session({ taps, a, tasters, onSave, onExit }) {
  const [plan, setPlan] = useState(null);
  const [customIds, setCustom] = useState([]);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState("taste");
  const [ti, setTi] = useState(0);
  const [draft, setDraft] = useState(emptyDraft());
  const [pending, setPending] = useState([]);
  const [sessionId] = useState(() => `S-${todayISO()}-${uid().slice(0, 4)}`);
  const [t0] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const active = tasters.filter((t) => t.active !== false);

  useEffect(() => {
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [t0]);

  const tapById = Object.fromEntries(taps.map((t) => [t.id, t]));

  if (!plan) {
    return (
      <div className="stack" style={{ maxWidth: 720 }}>
        <div className="lc-h">Build the flight</div>
        <div className="stack">
          {FLIGHTS.map((f) => (
            <button key={f.id} className="lc-card" style={{ textAlign: "left" }} onClick={() => setPlan(buildPlan(f.id, taps, a, []))}>
              <div className="lc-row"><b style={{ fontSize: 15 }}>{f.label} · {f.day}</b></div>
              <div className="dim" style={{ fontSize: 12.5, marginTop: 5 }}>{f.groups.join(" · ")}</div>
            </button>
          ))}
        </div>
        <div className="lc-card">
          <div className="lc-k" style={{ marginBottom: 8 }}>Or pick them yourself</div>
          <div className="fchips">
            {taps.filter((t) => t.active && !t.onDeck).sort((x, y) => x.line - y.line).map((t) => (
              <button key={t.id} className="fchip" data-on={customIds.includes(t.id) ? "1" : "0"}
                onClick={() => setCustom(customIds.includes(t.id) ? customIds.filter((x) => x !== t.id) : [...customIds, t.id])}>
                <em>{t.line}</em>{t.brand}
              </button>
            ))}
          </div>
          <button className="btn" style={{ marginTop: 10 }} disabled={!customIds.length} onClick={() => setPlan(buildPlan("custom", taps, a, customIds))}>
            Build a {customIds.length}-sample flight
          </button>
        </div>
        <button className="btn" data-ghost="1" onClick={onExit}>Cancel</button>
      </div>
    );
  }

  const total = plan.samples.length;
  const sample = plan.samples[idx];
  const tap = tapById[sample.tapId];

  if (phase === "done") {
    return (
      <div className="stack" style={{ maxWidth: 820 }}>
        <div className="lc-h">Session complete · {Math.floor(elapsed / 60)} min</div>
        <div className="lc-row">
          <button className="btn" data-p="1" onClick={() => { onSave(pending, { id: sessionId, date: todayISO(), flight: plan.flightId }); onExit(); }}>
            Save this session
          </button>
        </div>
      </div>
    );
  }

  const advanceTaster = (row) => {
    const next = [...pending, row];
    setPending(next);
    setDraft(emptyDraft());
    if (ti + 1 < active.length) { setTi(ti + 1); return; }
    setTi(0);
    if (idx + 1 < total) { setIdx(idx + 1); }
    else setPhase("done");
  };

  const taster = active[ti];
  return (
    <div style={{ maxWidth: 720 }}>
      <div className="rail">{plan.samples.map((_, i) => <i key={i} data-on={i < idx ? "2" : i === idx ? "1" : "0"} />)}</div>
      <TasteCard tap={tap} taster={taster} draft={draft} set={setDraft} idx={idx} total={total} elapsed={elapsed}
        onSubmit={() => advanceTaster({
          id: uid(), sessionId, date: todayISO(), tapId: tap.id, tasterId: taster.id,
          ttb: draft.ttb, modalities: draft.modalities, liking: draft.liking, faults: draft.faults, action: draft.action, note: draft.note,
          pkg: tap.pkg, dlScore: tap.dlScore, ageDays: daysSince(tap.pkg), line: tap.line,
        })}
      />
    </div>
  );
}

function Taps({ taps, setTaps, settings }) {
  const upd = (id, patch) => setTaps(taps.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const add = () => setTaps([...taps, {
    id: uid(), line: 0, brand: "", style: "Light & Crisp", pkg: "", dlScore: "", shelf: settings.defaultShelfDays, active: true, onDeck: false,
  }]);

  const renderTable = (list, title) => (
    <div className="lc-sec">
      <div className="lc-h">{title} ({list.length})</div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr>
            <th style={{ width: 52 }}>Line</th><th>Brand</th><th style={{ width: 130 }}>Style</th>
            <th style={{ width: 130 }}>Packaged</th><th style={{ width: 70 }}>Shelf</th><th style={{ width: 90 }}>DL Score</th>
            <th style={{ width: 100 }}>Status</th><th style={{ width: 34 }} />
          </tr></thead>
          <tbody>
            {list.sort((a, b) => a.line - b.line).map((t) => (
              <tr key={t.id} style={{ opacity: t.active ? 1 : 0.4 }}>
                <td><input className="lc-mono" type="number" value={t.line} onChange={(e) => upd(t.id, { line: Number(e.target.value) })} style={{ padding: "5px 6px" }} /></td>
                <td><input value={t.brand} onChange={(e) => upd(t.id, { brand: e.target.value })} style={{ padding: "5px 6px" }} placeholder="Brand" /></td>
                <td><select value={t.style} onChange={(e) => upd(t.id, { style: e.target.value })} style={{ padding: "5px 6px" }}>
                  {STYLE_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}
                </select></td>
                <td><input type="date" value={t.pkg} onChange={(e) => upd(t.id, { pkg: e.target.value })} style={{ padding: "5px 6px" }} /></td>
                <td><input className="lc-mono" type="number" value={t.shelf} onChange={(e) => upd(t.id, { shelf: Number(e.target.value) })} style={{ padding: "5px 6px" }} /></td>
                <td><input className="lc-mono" value={t.dlScore || ""} onChange={(e) => upd(t.id, { dlScore: e.target.value })} style={{ padding: "5px 6px" }} placeholder="ex: 7.2" /></td>
                <td>
                  <select value={t.onDeck ? "deck" : t.active ? "active" : "off"} onChange={(e) => {
                    const v = e.target.value;
                    upd(t.id, { active: v !== "off", onDeck: v === "deck" });
                  }} style={{ padding: "5px 6px" }}>
                    <option value="active">Active Wall</option><option value="deck">On Deck</option><option value="off">Inactive</option>
                  </select>
                </td>
                <td><button className="btn btn-sm" data-ghost="1" onClick={() => setTaps(taps.filter((x) => x.id !== t.id))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      <div className="lc-h">Tap Manager<button className="btn btn-sm" data-p="1" style={{ marginLeft: "auto" }} onClick={add}>Add a tap</button></div>
      <p className="lc-lede">Changing a package date treats that beer as a completely new batch, wiping its active bar stats clean.</p>
      {renderTable(taps.filter(t => !t.onDeck), "Active Tap Wall")}
      {renderTable(taps.filter(t => t.onDeck), "On Deck Queue")}
    </div>
  );
}

function Data({ a, results, taps, settings, tasters }) {
  const tasterName = (id) => tasters.find((t) => t.id === id)?.name || id;
  const exportCsv = () => {
    const head = ["date", "session", "line", "brand", "style", "package_date", "dl_score",
      "days_since_package", "taster", "true_to_brand", "miss_modalities", "liking",
      "faults", "fault_origins", "action", "note"];
    const tapById = a.tapById;
    const lines = [head.join(",")];
    for (const r of results.slice().sort((x, y) => x.date.localeCompare(y.date))) {
      const t = tapById[r.tapId] || {};
      lines.push([
        r.date, r.sessionId, t.line, t.brand, t.style, r.pkg, r.dlScore, r.ageDays, tasterName(r.tasterId),
        r.ttb, (r.modalities || []).join("|"), r.liking,
        (r.faults || []).map((f) => `${FAULTS.find((d) => d.id === f.id)?.label || f.id}:${f.i}`).join("|"),
        (r.faults || []).map((f) => FAULTS.find((d) => d.id === f.id)?.origin || "").join("|"),
        r.action, r.note,
      ].map(csvCell).join(","));
    }
    download(`linecheck_oakley_${todayISO()}.csv`, lines.join("\n"));
  };

  const curves = a.brandCurves.filter((c) => c.n >= 4);

  return (
    <div className="stack">
      <div className="lc-row">
        <div><div className="lc-h" style={{ margin: 0 }}>Data & Tracking</div></div>
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={exportCsv}>Export every score as CSV</button>
      </div>
      
      <div className="lc-sec">
        <div className="lc-h">Shelf life trends</div>
        <p className="lc-lede">Liking vs days since package. The dashed amber line is your action limit; where the fit crosses it is where the beer usually falls out of code.</p>
        {curves.length === 0 ? <div className="lc-card dim" style={{ fontSize: 13 }}>Needs at least four scored samples at different ages to plot.</div> : 
          <div className="lc-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))" }}>
            {curves.map((c) => (
              <div className="lc-card" key={c.brand}>
                <div className="lc-row" style={{ marginBottom: 6 }}><b style={{ fontSize: 14 }}>{c.brand}</b><span className="chip" style={{ marginLeft: "auto" }}>n={c.n}</span></div>
                <Scatter curve={c} settings={settings} />
                <div style={{ fontSize: 12.5, marginTop: 6 }}>
                  {c.fit ? <>Losing <b className="lc-mono">{Math.abs(c.fit.slope * 30).toFixed(2)}</b> points per month. {c.crossDays ? <>Crosses the action limit around day <b className="lc-mono warn">{c.crossDays}</b></> : <span className="dim"> Holding up.</span>}</> : <span className="dim">Not enough spread to fit a line.</span>}
                </div>
              </div>
            ))}
          </div>}
      </div>

      <div className="lc-sec">
        <div className="lc-h">Line report card</div>
        <p className="lc-lede">Mean liking by tap line compared to the house average ({a.houseMean === null ? "—" : a.houseMean.toFixed(2)}). Lines that sit consistently low across multiple brands indicate a dirty line or a hardware issue.</p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Line</th><th>Checks</th><th>Brands Poured</th><th>Mean Liking</th><th>Vs House Avg</th><th>Line-side Faults</th><th>Status</th></tr></thead>
            <tbody>
              {a.lineStats.map((l) => (
                <tr key={l.line}>
                  <td className="n">{String(l.line).padStart(2, "0")}</td>
                  <td className="n dim">{l.n}</td>
                  <td className="n dim">{l.brands}</td>
                  <td className="n">{l.mean === null ? "—" : l.mean.toFixed(2)}</td>
                  <td className="n" style={{ color: l.delta === null ? "var(--dim)" : l.delta < -0.5 ? "var(--red)" : l.delta < -0.2 ? "var(--amber)" : "var(--green)" }}>
                    {l.delta === null ? "—" : (l.delta > 0 ? "+" : "") + l.delta.toFixed(2)}
                  </td>
                  <td className="n dim">{l.lineFaults || "—"}</td>
                  <td style={{ fontSize: 12 }}>
                    {l.suspect ? <span className="chip" data-t="line">clean this line</span> : l.n < 5 ? <span className="dim">need more data</span> : l.brands === 1 && l.delta !== null && l.delta <= -0.8 ? <span className="chip" data-t="info">confounded</span> : <span className="dim">normal</span>}
                  </td>
                </tr>
              ))}
              {a.lineStats.length === 0 && <tr><td colSpan={7} className="dim">No sessions saved yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="lc-sec">
        <div className="lc-h">Fault Frequency</div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Fault</th><th>Origin</th><th>Hits</th><th>Taps Affected</th><th>Avg Intensity</th></tr></thead>
            <tbody>
              {a.pareto.slice(0, 10).map((f) => (
                <tr key={f.id}>
                  <td>{f.def?.label}</td>
                  <td><span className="chip" data-t={f.def?.origin === "L" ? "line" : f.def?.origin === "B" ? "warn" : "info"}>{f.def?.origin === "L" ? "line" : f.def?.origin === "B" ? "beer" : "either"}</span></td>
                  <td className="n">{f.n}</td>
                  <td className="n dim">{f.taps}</td>
                  <td className="n" style={{ color: f.avgI >= settings.faultPull ? "var(--red)" : f.avgI >= settings.faultInvestigate ? "var(--amber)" : "inherit" }}>{f.avgI.toFixed(1)}</td>
                </tr>
              ))}
              {a.pareto.length === 0 && <tr><td colSpan={5} className="dim">No faults logged yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="lc-sec">
        <div className="lc-h">Panelist Calibration</div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Panelist</th><th>Scores</th><th>Mean</th><th>Bias (vs Panel)</th><th>Not-True Rate</th></tr></thead>
            <tbody>
              {a.tasterStats.map((t) => (
                <tr key={t.tasterId}>
                  <td>{tasterName(t.tasterId)}</td>
                  <td className="n dim">{t.n}</td>
                  <td className="n">{t.mean === null ? "—" : t.mean.toFixed(2)}</td>
                  <td className="n">{t.bias === null ? "—" : (t.bias > 0 ? "+" : "") + t.bias.toFixed(2)}</td>
                  <td className="n dim">{t.notTrueRate === null ? "—" : Math.round(t.notTrueRate * 100) + "%"}</td>
                </tr>
              ))}
              {a.tasterStats.length === 0 && <tr><td colSpan={5} className="dim">No sessions saved yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const TABS = [["board", "Board"], ["session", "Taste"], ["taps", "Taps"], ["data", "Data"]];

export default function LineCheck() {
  const [tab, setTab] = useState("board");
  const [loaded, setLoaded] = useState(false);
  const [syncStatus, setSync] = useState("checking");
  const [taps, setTaps] = useState(SEED_TAPS);
  const [tasters] = useState(SEED_TASTERS);
  const [settings] = useState(DEFAULT_SETTINGS);
  const [results, setResults] = useState([]);
  const dirty = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const core = await sGet(K_CORE);
      if (!alive) return;
      if (core) {
        setTaps(core.taps?.length ? core.taps : SEED_TAPS);
        const ms = (core.months || []).slice(-18);
        const chunks = await Promise.all(ms.map((m) => sGet(K_RES(m))));
        if (alive) { setResults(chunks.filter(Boolean).flat()); setSync("synced"); }
      } else {
        const ok = await sSet(K_CORE, { taps: SEED_TAPS, months: [ymOf(todayISO())] });
        if (alive) setSync(ok ? "synced" : "error");
      }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    dirty.current = true;
    const id = setTimeout(async () => {
      const months = [...new Set(results.map(r => ymOf(r.date))), ymOf(todayISO())];
      const ok = await sSet(K_CORE, { taps, months });
      setSync(ok ? "synced" : "error");
      dirty.current = false;
    }, 1000);
    return () => clearTimeout(id);
  }, [taps, loaded, results]);

  const saveSession = useCallback(async (rows, meta) => {
    const ym = ymOf(meta.date);
    const prevResults = results;
    const nextResults = [...prevResults, ...rows];
    setResults(nextResults);
    const existing = (await sGet(K_RES(ym))) || prevResults.filter((r) => ymOf(r.date) === ym);
    const ok = await sSet(K_RES(ym), [...existing, ...rows]);
    setSync(ok ? "synced" : "error");
  }, [results]);

  const a = useMemo(() => analyze(taps, results, settings), [taps, results, settings]);

  if (!loaded) return <div className="lc"><div className="lc-wrap" style={{ paddingTop: 60 }}><div className="lc-mono dim">CONNECTING TO CLOUD...</div></div></div>;

  return (
    <div className="lc">
      <style>{CSS}</style>
      <div className="lc-top">
        <div className="lc-topin">
          <div className="lc-mark"><b>Line Check</b><span>MadTree · Oakley</span></div>
          <div className="lc-nav">
            {TABS.map(([k, l]) => (
              <button key={k} data-on={tab === k ? "1" : "0"} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="lc-wrap">
        {syncStatus === "error" && <div className="alert" data-t="bad" style={{ marginBottom: 16 }}><div><div className="alert-b">Cloud Sync Failed</div><div className="alert-d">Check your internet connection or Firebase setup.</div></div></div>}
        {tab === "board" && <Board a={a} settings={settings} onGo={() => setTab("session")} />}
        {tab === "session" && <Session taps={taps} a={a} tasters={tasters} onSave={saveSession} onExit={() => setTab("board")} />}
        {tab === "taps" && <Taps taps={taps} setTaps={setTaps} settings={settings} />}
        {tab === "data" && <Data a={a} results={results} taps={taps} settings={settings} tasters={tasters} />}
      </div>
    </div>
  );
}