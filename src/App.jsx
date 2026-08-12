import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, doc, query, where,
  onSnapshot, getDocs, setDoc, deleteDoc, writeBatch,
} from "firebase/firestore";

/* ============================================================================
   LINE CHECK — MadTree Oakley draft sensory program
   ----------------------------------------------------------------------------
   What changed in Rev 2, and why:

   1. Every score writes to the cloud the moment it is entered, as its own
      document. Rev 1 held the whole session in memory and wrote one big array
      at the end, so a dead phone at sample 9 of 11 lost the morning, and two
      people tasting at once overwrote each other. That cannot happen now.
   2. Live sync. Everyone sees the same wall, the same session, the same
      results, as they happen. Multiple people on the same flight see each
      other's progress and the panel mean lands as soon as two scores are in.
   3. The action limits from the SOP are computed, not remembered. The app
      tells you what the numbers say after you have scored, and records when
      the human call overrode it.
   4. Signals. Section 8 of the SOP — is it the beer or is it the line — is a
      pattern-matching job, and patterns are what software is for. The rules
      run continuously over the last three weeks of data and surface as
      specific instructions with the evidence attached.
   5. Drift. Every tap carries a trace of its scores against the DraughtLab
      release score. That gap is the entire reason this program exists.

   Firestore layout (top-level collections):
     config/app        settings
     taps/{id}         one doc per tap
     tasters/{id}      one doc per panelist
     sessions/{id}     one doc per tasting session (presence + plan)
     results/{id}      one doc per score

   Data written by Rev 1 (linecheck/linecheck:core:v1 and :res:YYYY-MM) is
   migrated on first load and left in place, untouched, as a backup.

   Suggested Firestore rules while this is an internal tool on a private URL:
     match /{doc=**} { allow read, write: if true; }
   Lock it down with Firebase Auth before it ever holds anything you care
   about keeping private.
   ========================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyCncjKiliby4dqoDLG8bft-CNum9Xac0tY",
  authDomain: "draft-beer-72e25.firebaseapp.com",
  projectId: "draft-beer-72e25",
  storageBucket: "draft-beer-72e25.firebasestorage.app",
  messagingSenderId: "887136359517",
  appId: "1:887136359517:web:d0dd56aa9654edb6eda9b4",
  measurementId: "G-9SWG68F7ET",
};

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

/* Legacy Rev 1 keys, read once for migration. */
const LEGACY_CORE = "linecheck:core:v1";
const LEGACY_RES = (ym) => `linecheck:res:${ym}`;

/* Device-local keys. These are per-phone, never synced. */
const LS_ME = "linecheck.me.v2";
const LS_OUTBOX = "linecheck.outbox.v2";
const LS_DRAFT = "linecheck.draft.v2";

/* ------------------------------------------------------------- vocabulary */

const STYLE_ORDER = [
  "Non Beer", "Light & Crisp", "Malty", "Fruity", "Hoppy", "Cocktail", "Barrel Aged",
];

/* Ascending intensity. Samples are always poured in this order so a heavy
   beer never sits in front of a delicate one. */
const PALATE_RANK = {
  "Non Beer": 1, "Light & Crisp": 2, "Malty": 3, "Fruity": 4,
  "Hoppy": 5, "Cocktail": 6, "Barrel Aged": 7,
};

const FLIGHTS = [
  {
    id: "A", day: 1, dayLabel: "Monday", label: "Flight A",
    groups: ["Non Beer", "Light & Crisp"],
    note: "Clean palate, unforgiving beers. A lager hides nothing.",
  },
  {
    id: "B", day: 3, dayLabel: "Wednesday", label: "Flight B",
    groups: ["Hoppy"],
    note: "Hop aroma fades fastest. Midweek catches the weekend's damage.",
  },
  {
    id: "C", day: 5, dayLabel: "Friday", label: "Flight C",
    groups: ["Malty", "Fruity", "Cocktail", "Barrel Aged"],
    note: "Palate-coating and adjunct beers go last in the week.",
  },
];

const TTB = [
  { v: "yes", label: "True", hint: "In spec. Pour it.", tone: "pass", key: "t" },
  { v: "marginal", label: "Marginal", hint: "Drifting. Look again next session.", tone: "watch", key: "m" },
  { v: "no", label: "Not true", hint: "Out of spec. Do not serve.", tone: "pull", key: "n" },
];

const MISS_WHERE = ["Appearance", "Aroma", "Flavor", "Mouthfeel", "Finish"];

const HEDONIC = {
  1: "Dislike extremely", 2: "Dislike very much", 3: "Dislike moderately",
  4: "Dislike slightly", 5: "Neither", 6: "Like slightly",
  7: "Like moderately", 8: "Like very much", 9: "Like extremely",
};
const HEDONIC_SHORT = {
  1: "Extremely", 2: "Very much", 3: "Moderately", 4: "Slightly", 5: "Neither",
  6: "Slightly", 7: "Moderately", 8: "Very much", 9: "Extremely",
};

/* origin: B = beer-side, L = line-side, BL = either, and the ambiguity is the
   whole diagnostic problem. */
const FAULTS = [
  { id: "papery", label: "Papery / cardboard", origin: "B", cause: "Oxidation. Packaging DO, keg headspace, or age." },
  { id: "sherry", label: "Sherry / stale toffee", origin: "B", cause: "Advanced staling. Age plus warm storage." },
  { id: "hopfade", label: "Hop aroma faded", origin: "B", cause: "Age. Check it against the freshness curve." },
  { id: "acetald", label: "Acetaldehyde / green apple", origin: "B", cause: "Young beer, rushed conditioning, or oxidation." },
  { id: "dms", label: "DMS / cooked corn", origin: "B", cause: "Boil vigor, whirlpool stand, or wort infection." },
  { id: "sulfur", label: "Sulfur / struck match", origin: "B", cause: "Yeast stress or a young lager. Often blows off." },
  { id: "astringent", label: "Astringent / drying", origin: "B", cause: "Polyphenol pickup. Sparge pH or grain crush." },
  { id: "diacetyl", label: "Diacetyl / butter, slick", origin: "BL", cause: "Incomplete VDK rest, or Pediococcus in the line." },
  { id: "phenol", label: "Band-aid / medicinal", origin: "BL", cause: "Wild yeast, or chlorinated sanitizer left in the line." },
  { id: "acetic", label: "Vinegar / acetic", origin: "L", cause: "Acetobacter. Air in the line or a dirty faucet." },
  { id: "lactic", label: "Sour / yogurt", origin: "L", cause: "Lactobacillus or Pediococcus biofilm." },
  { id: "moldy", label: "Moldy / musty / earthy", origin: "L", cause: "Mold in the faucet, FOB, or drip tray splash-back." },
  { id: "metallic", label: "Metallic / blood", origin: "L", cause: "Beer stone, corroded coupler, or a worn shank." },
  { id: "flat", label: "Flat / overcarbonated", origin: "L", cause: "Gas blend or pressure. Check the whole bank." },
];
const FAULT_BY_ID = Object.fromEntries(FAULTS.map((f) => [f.id, f]));

const ORIGIN_LABEL = { B: "beer", L: "line", BL: "either" };

const JAR_ATTRS = [
  { id: "hop", label: "Hop aroma", lo: "Muted", hi: "Loud" },
  { id: "bitter", label: "Bitterness", lo: "Soft", hi: "Sharp" },
  { id: "malt", label: "Malt", lo: "Thin", hi: "Heavy" },
  { id: "body", label: "Body", lo: "Watery", hi: "Thick" },
  { id: "carb", label: "Carbonation", lo: "Flat", hi: "Prickly" },
  { id: "finish", label: "Finish", lo: "Short", hi: "Lingering" },
];

const ACTIONS = [
  { v: "pass", label: "Pass", tone: "pass", hint: "Keep pouring." },
  { v: "watch", label: "Watch", tone: "watch", hint: "Re-taste next session." },
  { v: "pull_line", label: "Clean line", tone: "pull", hint: "Pull and clean the line." },
  { v: "pull_keg", label: "Pull keg", tone: "pull", hint: "Off the wall now." },
];
const ACTION_BY_V = Object.fromEntries(ACTIONS.map((a) => [a.v, a]));

const FLAG_REASONS = [
  "Tastes off", "Pouring foamy", "Pouring flat", "Warm", "Cloudy", "Slow pour",
];

const DEFAULT_SETTINGS = {
  likingPass: 6.5,
  likingWatch: 5.5,
  faultInvestigate: 3,
  faultPull: 4,
  defaultShelfDays: 120,
  coverageDays: 7,
  driftAlert: 1.0,
  signalWindow: 21,
  /* From the hospitality workbook: these three carry a longer code. */
  shelfOverrides: [
    { match: "Zip's Pilz", days: 180 },
    { match: "Liquid Sunshine", days: 180 },
    { match: "Old Stick", days: 180 },
  ],
};

/* ------------------------------------------------------------------ utils */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ymOf = (iso) => (iso || todayISO()).slice(0, 7);
const shiftISO = (iso, days) => {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
}
const daysSince = (iso) => (iso ? daysBetween(iso, todayISO()) : null);

function fmtDate(iso) {
  if (!iso) return "\u2014";
  const [y, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
}
function fmtAgo(days) {
  if (days === null || days === undefined) return "never";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
const num = (x) => typeof x === "number" && !Number.isNaN(x);

/* Ordinary least squares. Returns null under three points, because a slope
   drawn through two samples is a rumour, not a trend. */
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

const kegId = (tapId, pkg) => `${tapId}::${pkg || "nopkg"}`;

function shelfFor(tap, settings) {
  if (num(tap.shelf) && tap.shelf > 0) return tap.shelf;
  const hit = (settings.shelfOverrides || []).find(
    (o) => o.match && (tap.brand || "").toLowerCase().includes(o.match.toLowerCase())
  );
  return hit ? hit.days : settings.defaultShelfDays;
}

function freshness(tap, settings) {
  const shelf = shelfFor(tap, settings);
  const age = daysSince(tap.pkg);
  if (age === null) return { age: null, shelf, frac: null, left: null, state: "unknown" };
  const frac = age / shelf;
  const state = frac >= 1 ? "expired" : frac >= 0.85 ? "code-risk" : frac >= 0.5 ? "mature" : "fresh";
  return { age, shelf, frac, left: shelf - age, state };
}

/* Straw through to rust. The bar literally gets darker as the keg gets older. */
function freshColor(frac) {
  if (frac === null || frac === undefined) return "var(--shank)";
  const f = clamp(frac, 0, 1.2);
  if (f >= 1) return "var(--pull)";
  const stops = [
    [0.0, [232, 210, 138]],
    [0.5, [222, 165, 74]],
    [0.85, [196, 112, 62]],
    [1.0, [176, 86, 52]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (f >= stops[i][0] && f <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const t = b[0] === a[0] ? 0 : (f - a[0]) / (b[0] - a[0]);
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function download(name, text, type = "text/csv") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

/* Local storage, defensively. Safari in private mode throws on write. */
const local = {
  get(k, fallback) {
    try {
      const raw = window.localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  set(k, v) {
    try { window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ }
  },
  del(k) {
    try { window.localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

/* ==========================================================================
   CLOUD LAYER
   Every write targets a single document, so two people editing two different
   taps — or scoring the same beer at the same time — never collide.
   ========================================================================== */

const col = {
  taps: () => collection(db, "taps"),
  tasters: () => collection(db, "tasters"),
  results: () => collection(db, "results"),
  sessions: () => collection(db, "sessions"),
};
const cfgDoc = () => doc(db, "config", "app");

/* Outbox: anything that failed to reach Firestore is parked on the device and
   retried. Bar wifi drops. Scores should not. */
function outboxAdd(entry) {
  const q = local.get(LS_OUTBOX, []);
  const next = q.filter((e) => !(e.path === entry.path && e.id === entry.id));
  next.push(entry);
  local.set(LS_OUTBOX, next.slice(-300));
}
function outboxCount() {
  return local.get(LS_OUTBOX, []).length;
}
async function outboxFlush() {
  const q = local.get(LS_OUTBOX, []);
  if (!q.length) return 0;
  const left = [];
  for (const e of q) {
    try {
      if (e.op === "delete") await deleteDoc(doc(db, e.path, e.id));
      else await setDoc(doc(db, e.path, e.id), e.data);
    } catch {
      left.push(e);
    }
  }
  local.set(LS_OUTBOX, left);
  return q.length - left.length;
}

async function writeDocMerge(path, id, data) {
  try {
    await setDoc(doc(db, path, id), data, { merge: true });
    return true;
  } catch (err) {
    console.warn("[linecheck] merge write failed", path, id, err);
    outboxAdd({ path, id, data });
    return false;
  }
}

async function writeDoc(path, id, data) {
  try {
    await setDoc(doc(db, path, id), data);
    return true;
  } catch (err) {
    console.warn("[linecheck] write parked in outbox", path, id, err);
    outboxAdd({ path, id, data });
    return false;
  }
}

async function removeDoc(path, id) {
  try {
    await deleteDoc(doc(db, path, id));
    return true;
  } catch (err) {
    /* A delete that quietly fails is worse than one that waits: the row is
       gone from this screen but comes straight back on the next snapshot. */
    console.warn("[linecheck] delete parked in outbox", path, id, err);
    outboxAdd({ path, id, op: "delete" });
    return false;
  }
}

/* -------------------------------------------------------------- migration */
/* Rev 1 stored everything as JSON strings inside two document shapes. Read
   them once, fan them out into real documents, and mark the config so this
   never runs twice. The old documents are left exactly where they are. */
async function migrateFromRev1() {
  let core = null;
  try {
    const snap = await getDocs(query(collection(db, "linecheck")));
    const map = {};
    snap.forEach((d) => { map[d.id] = d.data(); });
    const raw = map[LEGACY_CORE];
    if (!raw || !raw.value) return { migrated: false, counts: null };
    core = JSON.parse(raw.value);

    const taps = Array.isArray(core.taps) ? core.taps : [];
    const tasters = Array.isArray(core.tasters) ? core.tasters : [];
    const months = Array.isArray(core.months) ? core.months : [];

    /* Sweep every month document actually present rather than trusting the
       month list inside the core doc. If a chunk was written but never
       registered, this still finds it. */
    let results = [];
    const monthKeys = new Set(months.map(LEGACY_RES));
    for (const key of Object.keys(map)) {
      if (key.startsWith("linecheck:res:")) monthKeys.add(key);
    }
    for (const key of monthKeys) {
      const rec = map[key];
      if (rec && rec.value) {
        try { results = results.concat(JSON.parse(rec.value) || []); } catch { /* unreadable chunk, skip */ }
      }
    }
    /* Rev 1 could write the same score twice on a retry. Keep one of each. */
    const seenIds = new Set();
    results = results.filter((r) => {
      const k = r.id || `${r.sessionId}|${r.tapId}|${r.tasterId}|${r.date}`;
      if (seenIds.has(k)) return false;
      seenIds.add(k);
      return true;
    });

    /* Chunk into batches of 400 to stay under the 500-op write limit. */
    const ops = [];
    for (const t of taps) ops.push(["taps", t.id || uid(), normalizeTap(t)]);
    for (const t of tasters) ops.push(["tasters", t.id || uid(), normalizeTaster(t)]);
    for (const r of results) ops.push(["results", r.id || uid(), normalizeResult(r)]);

    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      for (const [path, id, data] of ops.slice(i, i + 400)) {
        batch.set(doc(db, path, id), data);
      }
      await batch.commit();
    }

    return {
      migrated: true,
      counts: { taps: taps.length, tasters: tasters.length, results: results.length },
    };
  } catch (err) {
    console.warn("[linecheck] migration skipped", err);
    return { migrated: false, counts: null, error: String(err) };
  }
}

function normalizeTap(t) {
  return {
    id: t.id || uid(),
    line: Number(t.line) || 0,
    brand: t.brand || "",
    style: STYLE_ORDER.includes(t.style) ? t.style : "Light & Crisp",
    pkg: t.pkg || "",
    dlScore: t.dlScore === undefined || t.dlScore === null ? "" : String(t.dlScore),
    shelf: num(t.shelf) ? t.shelf : null,
    active: t.active !== false,
    onDeck: !!t.onDeck,
    notes: t.notes || "",
    flag: t.flag || null,
  };
}
function normalizeTaster(t) {
  return {
    id: t.id || uid(),
    name: t.name || "",
    title: t.title || "",
    active: t.active !== false,
    trainee: !!t.trainee,
  };
}
function normalizeResult(r) {
  return {
    id: r.id || uid(),
    sessionId: r.sessionId || "legacy",
    date: r.date || todayISO(),
    tapId: r.tapId || "",
    tasterId: r.tasterId || "",
    line: num(r.line) ? r.line : null,
    pkg: r.pkg || "",
    dlScore: r.dlScore === undefined || r.dlScore === null ? "" : String(r.dlScore),
    ageDays: num(r.ageDays) ? r.ageDays : null,
    ttb: r.ttb || null,
    missWhere: Array.isArray(r.missWhere) ? r.missWhere : (r.modalities || []),
    liking: num(r.liking) ? r.liking : null,
    faults: Array.isArray(r.faults) ? r.faults : [],
    jar: r.jar || null,
    action: r.action || null,
    recommended: r.recommended || null,
    note: r.note || "",
    at: r.at || null,
  };
}

/* ---------------------------------------------------------------- the hook */
function useCloud() {
  const [taps, setTaps] = useState([]);
  const [tasters, setTasters] = useState([]);
  const [results, setResults] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [sync, setSync] = useState("connecting");
  const [parked, setParked] = useState(outboxCount());
  const [archive, setArchive] = useState(null); // full history, loaded on demand

  /* Live subscriptions. The results feed is windowed to keep reads cheap;
     everything older is fetched on request from the Data tab. */
  useEffect(() => {
    const cutoff = shiftISO(todayISO(), -210);
    const subs = [];
    let alive = true;

    const guard = (fn) => (snap) => { if (alive) { fn(snap); setSync("live"); } };
    const fail = (label) => (err) => {
      console.warn("[linecheck] subscription lost:", label, err);
      if (alive) setSync("offline");
    };

    (async () => {
      /* Config first: it tells us whether Rev 1 data has already been moved. */
      let cfg = null;
      try {
        const snap = await getDocs(query(collection(db, "config")));
        snap.forEach((d) => { if (d.id === "app") cfg = d.data(); });
      } catch (err) {
        console.warn("[linecheck] config read failed", err);
      }

      if (!cfg) {
        const res = await migrateFromRev1();
        cfg = {
          ...DEFAULT_SETTINGS,
          migratedFrom: res.migrated ? "rev1" : "fresh",
          migratedAt: new Date().toISOString(),
          migratedCounts: res.counts || null,
        };
        await writeDoc("config", "app", cfg);
      }
      if (!alive) return;
      setSettings({ ...DEFAULT_SETTINGS, ...cfg });

      subs.push(onSnapshot(cfgDoc(),
        guard((d) => { if (d.exists()) setSettings({ ...DEFAULT_SETTINGS, ...d.data() }); }),
        fail("config")));

      subs.push(onSnapshot(col.taps(),
        guard((s) => setTaps(s.docs.map((d) => normalizeTap({ ...d.data(), id: d.id })))),
        fail("taps")));

      subs.push(onSnapshot(col.tasters(),
        guard((s) => setTasters(s.docs.map((d) => normalizeTaster({ ...d.data(), id: d.id })))),
        fail("tasters")));

      subs.push(onSnapshot(query(col.results(), where("date", ">=", cutoff)),
        guard((s) => setResults(s.docs.map((d) => normalizeResult({ ...d.data(), id: d.id })))),
        fail("results")));

      subs.push(onSnapshot(query(col.sessions(), where("date", ">=", shiftISO(todayISO(), -2))),
        guard((s) => setSessions(s.docs.map((d) => ({ ...d.data(), id: d.id })))),
        fail("sessions")));

      setReady(true);
    })();

    return () => { alive = false; subs.forEach((u) => { try { u(); } catch { /* ignore */ } }); };
  }, []);

  /* Retry parked writes on reconnect and every half minute. */
  useEffect(() => {
    let stop = false;
    const run = async () => {
      if (stop) return;
      const sent = await outboxFlush();
      const left = outboxCount();
      setParked(left);
      if (sent > 0 && left === 0) setSync("live");
    };
    const iv = setInterval(run, 30000);
    window.addEventListener("online", run);
    run();
    return () => { stop = true; clearInterval(iv); window.removeEventListener("online", run); };
  }, []);

  const bump = useCallback((ok) => {
    setSync(ok ? "live" : "offline");
    setParked(outboxCount());
  }, []);

  const api = useMemo(() => ({
    async saveTap(tap) {
      setTaps((prev) => {
        const i = prev.findIndex((t) => t.id === tap.id);
        return i === -1 ? [...prev, tap] : prev.map((t) => (t.id === tap.id ? tap : t));
      });
      bump(await writeDoc("taps", tap.id, normalizeTap(tap)));
    },
    async deleteTap(id) {
      setTaps((prev) => prev.filter((t) => t.id !== id));
      bump(await removeDoc("taps", id));
    },
    async saveTaps(list) {
      setTaps((prev) => {
        const map = Object.fromEntries(prev.map((t) => [t.id, t]));
        for (const t of list) map[t.id] = t;
        return Object.values(map);
      });
      try {
        for (let i = 0; i < list.length; i += 400) {
          const batch = writeBatch(db);
          for (const t of list.slice(i, i + 400)) batch.set(doc(db, "taps", t.id), normalizeTap(t));
          await batch.commit();
        }
        bump(true);
      } catch (err) {
        console.warn("[linecheck] bulk tap write failed", err);
        for (const t of list) outboxAdd({ path: "taps", id: t.id, data: normalizeTap(t) });
        bump(false);
      }
    },
    async saveTaster(t) {
      setTasters((prev) => {
        const i = prev.findIndex((x) => x.id === t.id);
        return i === -1 ? [...prev, t] : prev.map((x) => (x.id === t.id ? t : x));
      });
      bump(await writeDoc("tasters", t.id, normalizeTaster(t)));
    },
    async deleteTaster(id) {
      setTasters((prev) => prev.filter((t) => t.id !== id));
      bump(await removeDoc("tasters", id));
    },
    async saveSettings(next) {
      setSettings(next);
      bump(await writeDoc("config", "app", next));
    },
    async saveResult(row) {
      const r = normalizeResult(row);
      setResults((prev) => (prev.some((x) => x.id === r.id) ? prev.map((x) => (x.id === r.id ? r : x)) : [...prev, r]));
      bump(await writeDoc("results", r.id, r));
      return r;
    },
    async deleteResult(id) {
      setResults((prev) => prev.filter((r) => r.id !== id));
      bump(await removeDoc("results", id));
    },
    async saveSession(s) {
      setSessions((prev) => {
        const i = prev.findIndex((x) => x.id === s.id);
        return i === -1 ? [...prev, s] : prev.map((x) => (x.id === s.id ? s : x));
      });
      /* Merged, so two people joining the same flight at the same moment do
         not wipe each other out of the participant list. */
      bump(await writeDocMerge("sessions", s.id, s));
    },
    async loadArchive() {
      try {
        const snap = await getDocs(col.results());
        const all = snap.docs.map((d) => normalizeResult({ ...d.data(), id: d.id }));
        setArchive(all);
        return all;
      } catch (err) {
        console.warn("[linecheck] archive load failed", err);
        return null;
      }
    },
  }), [bump]);

  return { taps, tasters, results, sessions, settings, ready, sync, parked, archive, api };
}

/* ==========================================================================
   STYLE
   Colour is reserved for signal. The interface itself is foam on stout with
   hairlines; green, gold and red only ever mean pass, watch and pull, and the
   straw-to-rust gradient only ever means keg age. If something on screen has
   colour, it is telling you to do something.
   ========================================================================== */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,400;9..144,600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

.lc {
  --stout:#0B0D11; --cellar:#13161C; --bench:#1A1E26; --raise:#222732;
  --shank:#2C313C; --shank2:#434B5B;
  --foam:#F2EFE6; --head:#99A2B1; --dim:#616A79; --faint:#454D5B;
  --pass:#55B98A; --watch:#E3B04B; --pull:#E2574A; --line:#A08BD6; --info:#6E9FD4;
  --beer:#D9903A;
  --sans:'Archivo',system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --gauge:'Fraunces',Georgia,serif;
  --r:10px; --r-sm:7px;
  background:var(--stout); color:var(--foam); font-family:var(--sans);
  min-height:100vh; font-size:15px; line-height:1.5; letter-spacing:-0.005em; text-align:left;
  -webkit-font-smoothing:antialiased; -webkit-tap-highlight-color:transparent;
}
.lc *, .lc *::before, .lc *::after { box-sizing:border-box; }

/* ---- host page ----
   This file is the whole app, so it takes the page with it. Vite's starter
   index.css and App.css centre #root, pad it, cap it at 1280px and restyle
   bare elements; any of that reaches in here and wins on specificity, which
   is how a heading ends up centred and unreadable. Both files can be emptied
   safely, but the app should not depend on that. */
body { margin:0; padding:0; display:block; place-items:normal; min-width:0; background:#0B0D11; }
#root { max-width:none; width:auto; margin:0; padding:0; text-align:left; display:block; }
.lc h1, .lc h2, .lc h3, .lc h4, .lc h5, .lc p {
  margin:0; padding:0; color:inherit; font:inherit; letter-spacing:inherit; text-align:inherit;
}
.lc a { color:inherit; font-weight:inherit; text-decoration:none; }

.lc button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; text-align:left; }
.lc :focus-visible { outline:2px solid var(--foam); outline-offset:2px; border-radius:4px; }
.lc input, .lc select, .lc textarea {
  font:inherit; color:var(--foam); background:var(--stout);
  border:1px solid var(--shank); border-radius:var(--r-sm); padding:8px 10px; width:100%;
}
.lc select { appearance:none; background-image:linear-gradient(45deg,transparent 50%,var(--dim) 50%),linear-gradient(135deg,var(--dim) 50%,transparent 50%); background-position:calc(100% - 15px) 52%,calc(100% - 10px) 52%; background-size:5px 5px,5px 5px; background-repeat:no-repeat; padding-right:28px; }
.lc input:focus, .lc select:focus, .lc textarea:focus { outline:none; border-color:var(--foam); }
.lc input::placeholder, .lc textarea::placeholder { color:var(--faint); }
.lc textarea { resize:vertical; font-family:var(--mono); font-size:12.5px; line-height:1.6; }
.lc-mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
.lc-gauge { font-family:var(--gauge); font-variant-numeric:lining-nums tabular-nums; letter-spacing:-0.01em; }

/* ---- shell ---- */
.wrap { max-width:1120px; margin:0 auto; padding:0 16px calc(96px + env(safe-area-inset-bottom)); }
.top { position:sticky; top:0; z-index:40; background:rgba(11,13,17,0.9); backdrop-filter:blur(14px) saturate(1.2); border-bottom:1px solid var(--shank); }
.top-in { max-width:1120px; margin:0 auto; padding:11px 16px; display:flex; align-items:center; gap:14px; }
.mark { display:flex; align-items:baseline; gap:8px; min-width:0; }
.mark b { font-family:var(--gauge); font-weight:600; font-size:19px; letter-spacing:-0.02em; }
.mark span { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:0.18em; color:var(--dim); white-space:nowrap; }
.nav { display:flex; gap:2px; margin-left:auto; }
.nav button { font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:0.13em; padding:8px 12px; border-radius:var(--r-sm); color:var(--dim); transition:color .14s, background .14s; }
.nav button:hover { color:var(--foam); background:var(--cellar); }
.nav button[data-on="1"] { background:var(--foam); color:var(--stout); font-weight:600; }
.me-btn { margin-left:10px; }
.navbar { display:none; }

/* ---- sync pip ---- */
.pip { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:0.13em; color:var(--dim); white-space:nowrap; }
.pip i { width:6px; height:6px; border-radius:50%; background:var(--pass); box-shadow:0 0 0 3px rgba(85,185,138,0.13); }
.pip[data-s="offline"] i { background:var(--watch); box-shadow:0 0 0 3px rgba(227,176,75,0.13); }
.pip[data-s="connecting"] i { background:var(--dim); box-shadow:none; animation:blink 1.1s ease-in-out infinite; }
@keyframes blink { 50% { opacity:0.25; } }

/* ---- type ---- */
.eyebrow { font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:0.16em; color:var(--dim); }
.h { display:flex; align-items:center; gap:12px; margin:0 0 12px; font-family:var(--mono); font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:0.16em; color:var(--head); }
.h::after { content:""; flex:1; height:1px; background:var(--shank); }
.h .h-act { margin-left:0; }
.lc .lede { color:var(--head); font-size:13.5px; max-width:70ch; margin:0 0 16px; }
.sec { margin:30px 0; }
.sec:first-child { margin-top:20px; }
.mut { color:var(--head); } .dim { color:var(--dim); }
.stack { display:grid; gap:14px; }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.hr { height:1px; background:var(--shank); border:0; margin:18px 0; }
.card { background:var(--cellar); border:1px solid var(--shank); border-radius:var(--r); padding:15px; }
.grid { display:grid; gap:10px; }

/* ---- hero: today's assignment ----
   This has to read as a panel from across the bar, not as a paragraph
   floating on the page, so it sits a full step above the background and
   carries a real edge rather than a hairline. */
.hero { border:1px solid var(--shank2); border-radius:var(--r); background:linear-gradient(160deg,var(--bench),var(--cellar) 64%); padding:20px 20px 18px; margin:18px 0 24px; position:relative; overflow:hidden; box-shadow:0 20px 44px -34px rgba(0,0,0,0.95); }
.hero::before { content:""; position:absolute; inset:0 auto 0 0; width:3px; background:var(--foam); opacity:0.85; }
.hero-top { display:flex; align-items:flex-start; gap:16px; flex-wrap:wrap; }
.hero .eyebrow { color:var(--head); }
.lc .hero-day { font-family:var(--gauge); font-size:clamp(28px,5vw,40px); font-weight:600; line-height:1.02; letter-spacing:-0.025em; }
.lc .hero-sub { color:var(--head); font-size:13.5px; margin-top:6px; max-width:52ch; }
.hero-cta { margin-left:auto; display:flex; flex-direction:column; align-items:stretch; gap:8px; min-width:210px; }
.hero-meta { display:flex; gap:22px; margin-top:16px; padding-top:14px; border-top:1px solid var(--shank2); flex-wrap:wrap; }
.stat b { display:block; font-family:var(--gauge); font-size:26px; font-weight:600; line-height:1.05; }
.stat span { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:0.13em; color:var(--dim); }

/* ---- buttons ---- */
.btn { font-family:var(--mono); font-size:11px; font-weight:500; text-transform:uppercase; letter-spacing:0.12em; padding:10px 15px; border-radius:var(--r-sm); border:1px solid var(--shank); background:var(--bench); color:var(--foam); transition:border-color .14s, background .14s, transform .1s; display:inline-flex; align-items:center; justify-content:center; gap:8px; text-align:center; }
.btn:hover { border-color:var(--shank2); background:var(--raise); }
.btn:active { transform:translateY(1px); }
.btn[data-p="1"] { background:var(--foam); color:var(--stout); border-color:var(--foam); font-weight:600; }
.btn[data-p="1"]:hover { background:#fff; }
.btn[data-ghost="1"] { background:none; color:var(--head); border-color:transparent; }
.btn[data-ghost="1"]:hover { color:var(--foam); background:var(--cellar); }
.btn[data-danger="1"] { color:var(--pull); border-color:rgba(226,87,74,0.35); }
.btn:disabled { opacity:0.32; cursor:not-allowed; transform:none; }
.btn-sm { padding:6px 10px; font-size:10px; letter-spacing:0.1em; }
.btn-lg { padding:15px 18px; font-size:12px; }
.btn-full { width:100%; }

/* ---- chips ---- */
.chip { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:0.1em; padding:3px 7px; border-radius:5px; border:1px solid var(--shank); color:var(--head); display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
.chip[data-t="pass"] { color:var(--pass); border-color:rgba(85,185,138,0.35); }
.chip[data-t="watch"] { color:var(--watch); border-color:rgba(227,176,75,0.35); }
.chip[data-t="pull"] { color:var(--pull); border-color:rgba(226,87,74,0.38); }
.chip[data-t="line"] { color:var(--line); border-color:rgba(160,139,214,0.35); }
.chip[data-t="info"] { color:var(--info); border-color:rgba(110,159,212,0.35); }
.chip[data-t="solid"] { background:var(--foam); color:var(--stout); border-color:var(--foam); font-weight:600; }

/* ---- the wall ---- */
.wall { border:1px solid var(--shank); border-radius:var(--r); overflow:hidden; background:var(--cellar); }
.wrow { display:grid; grid-template-columns:44px minmax(0,1fr) 96px 60px 132px; gap:12px; align-items:center; padding:11px 14px; border-bottom:1px solid var(--shank); width:100%; background:none; transition:background .12s; }
.wrow:last-child { border-bottom:0; }
.wrow:hover { background:var(--bench); }
.wrow-n { font-family:var(--gauge); font-size:21px; font-weight:600; color:var(--dim); line-height:1; text-align:right; font-variant-numeric:lining-nums; }
.wrow[data-s="pass"] .wrow-n { color:var(--pass); }
.wrow[data-s="watch"] .wrow-n { color:var(--watch); }
.wrow[data-s="pull"] .wrow-n { color:var(--pull); }
.wrow-name { font-weight:600; font-size:14.5px; letter-spacing:-0.012em; line-height:1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wrow-sub { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:0.1em; color:var(--dim); margin-top:3px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.wrow-score { font-family:var(--gauge); font-size:23px; font-weight:600; line-height:1; text-align:right; }
.wrow-score small { display:block; font-family:var(--mono); font-size:8.5px; font-weight:400; letter-spacing:0.1em; text-transform:uppercase; color:var(--dim); margin-top:4px; }
.wall-head { display:grid; grid-template-columns:44px minmax(0,1fr) 96px 60px 132px; gap:12px; padding:9px 14px; border-bottom:1px solid var(--shank2); font-family:var(--mono); font-size:9px; text-transform:uppercase; letter-spacing:0.14em; color:var(--dim); background:var(--bench); }
.wall-head span:nth-child(3), .wall-head span:nth-child(4) { text-align:right; }

/* ---- the record: one filed score per row, removable ---- */
.rrow { display:grid; grid-template-columns:38px minmax(0,1fr) 40px 34px; gap:10px; align-items:center; padding:9px 12px; border-bottom:1px solid var(--shank); }
.rrow:last-child { border-bottom:0; }
.rrow-n { font-family:var(--mono); font-size:11px; color:var(--dim); }
.rrow-name { font-size:13.5px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rrow-sub { display:flex; flex-wrap:wrap; align-items:center; gap:7px; margin-top:2px; font-family:var(--mono); font-size:10px; color:var(--dim); }
.rrow-score { font-family:var(--gauge); font-size:19px; font-weight:600; text-align:right; font-variant-numeric:lining-nums tabular-nums; }
.rrow-x { display:flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:var(--r-sm); border:1px solid transparent; color:var(--faint); font-size:17px; line-height:1; transition:color .13s, border-color .13s, background .13s; }
.rrow-x:hover { color:var(--pull); border-color:rgba(226,87,74,0.4); background:rgba(226,87,74,0.08); }

/* ---- freshness bar ---- */
.fresh { position:relative; height:5px; border-radius:3px; background:var(--stout); border:1px solid var(--shank); overflow:hidden; }
.fresh i { position:absolute; inset:0 auto 0 0; display:block; border-radius:2px; transition:width .4s ease; }
.fresh-lab { display:flex; justify-content:space-between; gap:8px; font-family:var(--mono); font-size:9px; letter-spacing:0.06em; color:var(--dim); margin-top:5px; }

/* ---- empty ---- */
.empty { border:1px dashed var(--shank2); border-radius:var(--r); padding:30px 22px; text-align:center; }.empty b { display:block; font-family:var(--gauge); font-size:20px; font-weight:600; margin-bottom:6px; }
.empty p { color:var(--head); font-size:13.5px; margin:0 auto 16px; max-width:44ch; }

/* ---- signals ---- */
.sig { display:grid; grid-template-columns:auto minmax(0,1fr); gap:13px; padding:14px 15px; border:1px solid var(--shank); border-left:3px solid var(--dim); border-radius:var(--r); background:var(--cellar); align-items:start; }
.sig[data-sev="pull"] { border-left-color:var(--pull); }
.sig[data-sev="watch"] { border-left-color:var(--watch); }
.sig[data-sev="info"] { border-left-color:var(--info); }
.sig[data-sev="line"] { border-left-color:var(--line); }
.sig-ic { font-family:var(--gauge); font-size:19px; font-weight:600; color:var(--dim); line-height:1.1; min-width:26px; }
.sig-t { font-weight:600; font-size:14px; letter-spacing:-0.01em; }
.sig-d { color:var(--head); font-size:13px; margin-top:4px; line-height:1.5; }
.sig-do { margin-top:9px; font-family:var(--mono); font-size:11px; color:var(--foam); border-top:1px dashed var(--shank); padding-top:9px; line-height:1.55; }
.sig-do b { color:var(--dim); font-weight:500; text-transform:uppercase; letter-spacing:0.13em; font-size:9.5px; display:block; margin-bottom:3px; }

/* ---- tasting card ---- */
.rail { display:flex; gap:3px; margin:0 0 14px; }
.rail i { flex:1; height:3px; border-radius:2px; background:var(--shank); transition:background .25s; }
.rail i[data-on="done"] { background:var(--dim); }
.rail i[data-on="now"] { background:var(--foam); }

/* ---- now tasting ----
   This is not a blind panel. Which beer is in the glass has to stay on
   screen the whole way down the card, so the identity block pins under the
   header and condenses as you scroll into the questions. */
.taste { position:relative; }
.pour { position:sticky; top:var(--top-h,51px); z-index:30; margin:0 -16px 16px; padding:2px 16px 14px;
  background:rgba(11,13,17,0.94); backdrop-filter:blur(14px) saturate(1.2);
  border-bottom:1px solid transparent; transition:border-color .18s, padding .18s; }
.pour[data-stuck="1"] { padding-top:9px; padding-bottom:9px; border-bottom-color:var(--shank); box-shadow:0 14px 22px -20px rgba(0,0,0,0.95); }
.pour-top { display:flex; align-items:flex-start; gap:13px; }
.pour-line { flex:none; display:flex; flex-direction:column; align-items:center; justify-content:center; min-width:48px; padding:6px 7px 5px; border:1px solid var(--shank2); border-radius:var(--r-sm); background:var(--cellar); transition:min-width .18s, padding .18s; }
.pour-line b { font-family:var(--gauge); font-size:25px; font-weight:600; line-height:1; letter-spacing:-0.02em; transition:font-size .18s; }
.pour-line span { font-family:var(--mono); font-size:7.5px; text-transform:uppercase; letter-spacing:0.18em; color:var(--dim); margin-top:4px; }
.pour[data-stuck="1"] .pour-line { min-width:38px; padding:4px 6px; }
.pour[data-stuck="1"] .pour-line b { font-size:17px; }
.pour[data-stuck="1"] .pour-line span { display:none; }
.pour-id { min-width:0; flex:1; }
.pour-eye { font-family:var(--mono); font-size:9px; text-transform:uppercase; letter-spacing:0.2em; color:var(--dim); }
.pour-brand { font-family:var(--gauge); font-size:clamp(26px,5.4vw,36px); font-weight:600; line-height:1.04; letter-spacing:-0.026em; margin-top:5px; overflow-wrap:anywhere; transition:font-size .18s, margin .18s; }
.pour-style { font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:0.15em; color:var(--head); margin-top:6px; }
.pour-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.pour[data-stuck="1"] .pour-eye, .pour[data-stuck="1"] .pour-style, .pour[data-stuck="1"] .pour-chips, .pour[data-stuck="1"] .pour-warm { display:none; }
.pour[data-stuck="1"] .pour-brand { font-size:clamp(17px,4.2vw,20px); margin-top:0; padding-top:2px; }
.pour-clock { flex:none; text-align:right; }
.pour-count { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:0.13em; color:var(--dim); white-space:nowrap; }
.pour-secs { font-family:var(--mono); font-variant-numeric:tabular-nums; font-size:15px; margin-top:4px; }
.pour-warm { font-family:var(--mono); font-size:8.5px; text-transform:uppercase; letter-spacing:0.11em; margin-top:3px; }
.pour-next { font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:0.12em; color:var(--dim); }
.pour-next b { color:var(--head); font-weight:500; }
.lineup { font-family:var(--mono); font-size:11px; color:var(--head); line-height:1.7; margin-top:8px; padding-top:8px; border-top:1px solid var(--shank); }
.qhead { display:flex; align-items:baseline; gap:10px; margin-bottom:9px; }
.qn { font-family:var(--gauge); font-size:13px; font-weight:600; color:var(--dim); }
.qt { font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:0.14em; color:var(--head); }
.qopt { font-family:var(--mono); font-size:9.5px; color:var(--faint); margin-left:auto; text-transform:uppercase; letter-spacing:0.1em; }
.opts { display:grid; gap:8px; }
.opts-3 { grid-template-columns:repeat(3,1fr); }
.opts-4 { grid-template-columns:repeat(4,1fr); }
.opt { border:1px solid var(--shank); border-radius:var(--r-sm); padding:13px 10px; text-align:center; background:var(--cellar); transition:border-color .13s, background .13s; }
.opt:hover { border-color:var(--shank2); }
.opt b { display:block; font-size:14px; font-weight:600; letter-spacing:-0.01em; }
.opt small { display:block; font-size:10.5px; color:var(--dim); margin-top:4px; line-height:1.35; }
.opt[data-on="1"][data-t="pass"] { background:rgba(85,185,138,0.1); border-color:var(--pass); color:var(--pass); }
.opt[data-on="1"][data-t="watch"] { background:rgba(227,176,75,0.1); border-color:var(--watch); color:var(--watch); }
.opt[data-on="1"][data-t="pull"] { background:rgba(226,87,74,0.1); border-color:var(--pull); color:var(--pull); }
.opt[data-rec="1"] { box-shadow:inset 0 0 0 1px var(--shank2); }
.opt[data-on="1"] small { color:inherit; opacity:0.75; }

.hed { display:grid; grid-template-columns:repeat(9,1fr); gap:6px; }
.hed button { border:1px solid var(--shank); border-radius:var(--r-sm); background:var(--cellar); padding:12px 2px 9px; text-align:center; transition:transform .1s, background .13s, border-color .13s; }
.hed button:hover { border-color:var(--shank2); }
.hed button b { display:block; font-family:var(--gauge); font-size:20px; font-weight:600; line-height:1; }
.hed button span { display:block; font-family:var(--mono); font-size:8px; text-transform:uppercase; letter-spacing:0.05em; color:var(--faint); margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hed button[data-on="1"] { background:var(--foam); color:var(--stout); border-color:var(--foam); transform:translateY(-2px); }
.hed button[data-on="1"] span { color:rgba(11,13,17,0.6); }
.hed-lab { display:flex; justify-content:space-between; font-family:var(--mono); font-size:9.5px; letter-spacing:0.08em; text-transform:uppercase; color:var(--dim); margin-top:8px; }

.fgrp { margin-bottom:12px; }
.fgrp-h { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:0.13em; color:var(--faint); margin-bottom:7px; display:flex; align-items:center; gap:8px; }
.fchips { display:flex; flex-wrap:wrap; gap:7px; }
.fchip { border:1px solid var(--shank); border-radius:var(--r-sm); padding:8px 11px; font-size:12.5px; background:var(--cellar); transition:border-color .13s, background .13s; }
.fchip:hover { border-color:var(--shank2); }
.fchip[data-on="1"] { border-color:var(--pull); background:rgba(226,87,74,0.12); color:#F2A79B; }
.fsel { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--pull); background:rgba(226,87,74,0.12); border-radius:var(--r-sm); padding:5px 6px 5px 11px; }
.fsel > b { font-size:12.5px; font-weight:500; color:#F2A79B; }
.fint { display:flex; gap:3px; }
.fint button { width:24px; height:24px; border-radius:5px; border:1px solid var(--shank); font-family:var(--mono); font-size:11px; display:flex; align-items:center; justify-content:center; background:var(--stout); }
.fint button[data-on="1"] { background:var(--pull); border-color:var(--pull); color:#fff; font-weight:600; }
.fint button[data-on="1"][data-hi="1"] { box-shadow:0 0 0 2px rgba(226,87,74,0.25); }
.fx { color:var(--dim); padding:0 4px; font-size:15px; line-height:1; }

.jar { display:grid; grid-template-columns:100px minmax(0,1fr); gap:12px; align-items:center; padding:7px 0; border-bottom:1px solid var(--shank); }
.jar:last-child { border-bottom:0; }
.jar-l { font-size:12.5px; color:var(--head); }
.jar-s { display:grid; grid-template-columns:repeat(5,1fr); gap:5px; }
.jar-s button { height:30px; border:1px solid var(--shank); border-radius:5px; background:var(--stout); font-family:var(--mono); font-size:10px; color:var(--dim); display:flex; align-items:center; justify-content:center; }
.jar-s button[data-on="1"] { background:var(--bench); border-color:var(--foam); color:var(--foam); }
.jar-s button[data-on="1"][data-mid="1"] { background:var(--foam); color:var(--stout); }

/* ---- verdict ---- */
.verd { border:1px solid var(--shank); border-radius:var(--r-sm); padding:11px 13px; background:var(--bench); display:flex; gap:11px; align-items:flex-start; }
.verd-k { font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:0.14em; color:var(--dim); }
.verd-v { font-weight:600; font-size:14px; margin-top:2px; }
.verd-w { color:var(--head); font-size:12.5px; margin-top:3px; line-height:1.45; }

/* ---- tables ---- */
.tbl-wrap { overflow-x:auto; border:1px solid var(--shank); border-radius:var(--r); background:var(--cellar); -webkit-overflow-scrolling:touch; }
.tbl { width:100%; border-collapse:collapse; font-size:13px; }
.tbl th { font-family:var(--mono); font-size:9px; text-transform:uppercase; letter-spacing:0.13em; color:var(--faint); text-align:left; padding:9px 10px; border-bottom:1px solid var(--shank); font-weight:500; white-space:nowrap; }
.tbl td { padding:8px 10px; border-bottom:1px solid rgba(38,43,53,0.6); vertical-align:middle; }
.tbl tr:last-child td { border-bottom:0; }
.tbl td.n { font-family:var(--mono); font-variant-numeric:tabular-nums; }
.tbl tr[data-off="1"] { opacity:0.42; }
.tbl input, .tbl select { padding:6px 8px; font-size:12.5px; }
.tbl select { background-position:calc(100% - 13px) 52%,calc(100% - 8px) 52%; padding-right:24px; }

/* ---- sheet ---- */
.scrim { position:fixed; inset:0; z-index:60; background:rgba(5,6,8,0.7); backdrop-filter:blur(3px); display:flex; align-items:flex-end; justify-content:center; animation:fade .16s ease; }
@keyframes fade { from { opacity:0; } }
@keyframes rise { from { transform:translateY(14px); opacity:0; } }
.sheet { width:100%; max-width:620px; max-height:88vh; overflow-y:auto; background:var(--cellar); border:1px solid var(--shank2); border-bottom:0; border-radius:14px 14px 0 0; padding:18px 18px calc(24px + env(safe-area-inset-bottom)); animation:rise .2s cubic-bezier(.2,.7,.3,1); }
.sheet-h { display:flex; align-items:flex-start; gap:12px; margin-bottom:14px; }
.sheet-h b { font-family:var(--gauge); font-size:22px; font-weight:600; line-height:1.15; letter-spacing:-0.02em; }
.sheet-x { margin-left:auto; font-size:22px; line-height:1; color:var(--dim); padding:0 4px; }

/* ---- misc ---- */
.toast { position:fixed; left:50%; bottom:calc(84px + env(safe-area-inset-bottom)); transform:translateX(-50%); z-index:70; background:var(--foam); color:var(--stout); font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:0.11em; font-weight:600; padding:10px 16px; border-radius:99px; animation:rise .18s ease; box-shadow:0 8px 24px rgba(0,0,0,0.4); }
.who { display:flex; align-items:center; gap:-4px; }
.av { width:26px; height:26px; border-radius:50%; border:1px solid var(--shank2); background:var(--bench); font-family:var(--mono); font-size:10px; font-weight:600; display:flex; align-items:center; justify-content:center; color:var(--head); margin-right:-6px; }
.av[data-on="1"] { background:var(--foam); color:var(--stout); border-color:var(--foam); }
.seg { display:inline-flex; border:1px solid var(--shank); border-radius:var(--r-sm); overflow:hidden; }
.seg button { font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:0.1em; padding:7px 11px; color:var(--dim); }
.seg button[data-on="1"] { background:var(--bench); color:var(--foam); }
.kv { display:flex; justify-content:space-between; gap:14px; padding:7px 0; border-bottom:1px solid var(--shank); font-size:13px; }
.kv:last-child { border-bottom:0; }
.kv span { color:var(--dim); font-family:var(--mono); font-size:10.5px; text-transform:uppercase; letter-spacing:0.1em; }
.bar-mini { height:4px; border-radius:2px; background:var(--shank); overflow:hidden; }
.bar-mini i { display:block; height:100%; background:var(--foam); }
.stagger > * { animation:rise .3s cubic-bezier(.2,.7,.3,1) backwards; }

/* ---- responsive ---- */
@media (max-width:860px) {
  .wrow, .wall-head { grid-template-columns:38px minmax(0,1fr) 54px; }
  .wrow-trace, .wall-head span:nth-child(3), .wall-head span:nth-child(5) { display:none; }
  .wrow-fresh { grid-column:2 / -1; }
  .wrow { row-gap:8px; }
}
@media (max-width:680px) {
  .lc { font-size:15px; }
  .wrap { padding-left:13px; padding-right:13px; }
  .nav { display:none; }
  .me-btn { margin-left:auto; }
  .mark span { display:none; }
  .navbar { display:flex; position:fixed; left:0; right:0; bottom:0; z-index:50; background:rgba(11,13,17,0.94); backdrop-filter:blur(14px); border-top:1px solid var(--shank); padding:6px 6px calc(6px + env(safe-area-inset-bottom)); }
  .navbar button { flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; padding:7px 2px; border-radius:var(--r-sm); font-family:var(--mono); font-size:9px; text-transform:uppercase; letter-spacing:0.1em; color:var(--dim); }
  .navbar button[data-on="1"] { color:var(--foam); background:var(--cellar); }
  .navbar b { font-family:var(--gauge); font-size:15px; font-weight:600; line-height:1; }
  .hero-cta { margin-left:0; width:100%; }
  .lc .hero-day { font-size:30px; }
  .opts-4 { grid-template-columns:repeat(2,1fr); }
  .hed { grid-template-columns:repeat(3,1fr); gap:7px; }
  .hed button { padding:14px 4px 11px; }
  .hed button b { font-size:23px; }
  .pour { margin-left:-13px; margin-right:-13px; padding-left:13px; padding-right:13px; }
  .jar { grid-template-columns:1fr; gap:6px; }
  .sheet { max-height:92vh; }
  .btn { padding:11px 15px; }
}
@media (prefers-reduced-motion:reduce) {
  .lc *, .lc *::before, .lc *::after { animation-duration:0.01ms !important; animation-iteration-count:1 !important; transition-duration:0.01ms !important; }
}
`;

/* ==========================================================================
   ANALYSIS
   A check is every score a tap collected on one day, from whoever was there.
   Grouping by day rather than by session id is deliberate: on a bring-your-
   own-phone panel, three people tasting the same beer at 10:04 produce three
   session ids and one check.
   ========================================================================== */

function buildChecks(results) {
  const map = {};
  for (const r of results) {
    if (!r.tapId || !r.date) continue;
    const k = `${r.tapId}|${r.date}`;
    (map[k] ||= { key: k, tapId: r.tapId, date: r.date, pkg: r.pkg || "", rows: [] }).rows.push(r);
  }
  return Object.values(map).map((c) => {
    const likes = c.rows.map((r) => r.liking).filter(num);
    const faults = c.rows.flatMap((r) => r.faults || []);
    const worst = faults.reduce((m, f) => (m === null || f.i > m.i ? f : m), null);
    return {
      ...c,
      n: c.rows.length,
      mean: mean(likes),
      sd: sd(likes),
      spread: likes.length > 1 ? Math.max(...likes) - Math.min(...likes) : null,
      ttbNo: c.rows.filter((r) => r.ttb === "no").length,
      ttbMarginal: c.rows.filter((r) => r.ttb === "marginal").length,
      faults,
      worstFault: worst,
      tasterIds: [...new Set(c.rows.map((r) => r.tasterId))],
      calls: c.rows.map((r) => r.action).filter(Boolean),
      ageDays: c.rows.map((r) => r.ageDays).find(num) ?? null,
    };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

/* The action limits from section 7, applied. Most severe rule wins, and the
   rule that fired is always named so a call can be argued with later. */
function verdictFor({ check, tap, settings, prevCheck, fresh }) {
  const out = (level, label, why, suggest) => ({ level, label, why, suggest: suggest || null });
  if (!check || check.mean === null) return out("none", "Not yet tasted", "No scores on this keg.", null);

  const worst = check.worstFault;
  const worstDef = worst ? FAULT_BY_ID[worst.id] : null;

  if (worst && worst.i >= settings.faultPull) {
    const side = worstDef ? worstDef.origin : "BL";
    const suggest = side === "L" ? "pull_line" : side === "B" ? "pull_keg" : null;
    return out("pull", "Pull",
      `${worstDef ? worstDef.label : worst.id} logged at ${worst.i} of 5. Anything at ${settings.faultPull} or above comes off the wall.`,
      suggest);
  }
  if (check.n >= 2 && check.ttbNo === check.n) {
    return out("pull", "Pull", "Every taster called it not true to brand. Liking does not matter here.", "pull_keg");
  }
  if (fresh && fresh.state === "expired") {
    return out("pull", "Pull", `${fresh.age} days on a ${fresh.shelf} day code. Pull it, or write the exception and put a tasting behind it.`, "pull_keg");
  }
  if (prevCheck && prevCheck.mean !== null && prevCheck.mean < settings.likingPass && check.mean < settings.likingPass) {
    return out("pull", "Pull",
      `Two checks in a row under ${settings.likingPass} (${prevCheck.mean.toFixed(1)} on ${fmtDate(prevCheck.date)}, then ${check.mean.toFixed(1)}).`, null);
  }
  if (check.mean < settings.likingWatch) {
    return out("investigate", "Investigate today",
      `Panel mean ${check.mean.toFixed(1)} is under ${settings.likingWatch}. Draw at the coupler and at the faucet before deciding.`, null);
  }
  if (worst && worst.i >= settings.faultInvestigate) {
    return out("investigate", "Investigate today",
      `${worstDef ? worstDef.label : worst.id} at ${worst.i} of 5${worstDef ? `. Usually ${ORIGIN_LABEL[worstDef.origin]}-side.` : "."}`, null);
  }
  if (check.n === 1 && check.ttbNo === 1) {
    return out("watch", "Watch", "One taster called it not true. Get a second palate on it before pulling.", "watch");
  }
  if (check.mean < settings.likingPass) {
    return out("watch", "Watch", `Panel mean ${check.mean.toFixed(1)} sits between ${settings.likingWatch} and ${settings.likingPass}. Re-taste next session.`, "watch");
  }
  return out("pass", "Pass", `Panel mean ${check.mean.toFixed(1)} is at or above ${settings.likingPass}.`, "pass");
}

const LEVEL_TONE = { pass: "pass", watch: "watch", investigate: "watch", pull: "pull", none: "" };

function analyze(taps, results, settings) {
  const tapById = Object.fromEntries(taps.map((t) => [t.id, t]));
  const checks = buildChecks(results);
  const checksByTap = {};
  for (const c of checks) (checksByTap[c.tapId] ||= []).push(c);

  const houseMean = mean(results.map((r) => r.liking).filter(num));

  const tapStats = taps.map((t) => {
    const all = checksByTap[t.id] || [];
    /* Current keg only. A package date change starts a clean sheet on the
       wall while the old scores stay in the record. */
    const kegChecks = all.filter((c) => (c.pkg || "") === (t.pkg || ""));
    const last = kegChecks[0] || null;
    const prev = kegChecks[1] || null;
    const fresh = freshness(t, settings);
    const verdict = verdictFor({ check: last, tap: t, settings, prevCheck: prev, fresh });
    const status = last ? LEVEL_TONE[verdict.level] || "" : "";
    const rows = results.filter((r) => r.tapId === t.id && (r.pkg || "") === (t.pkg || ""));
    const likes = rows.map((r) => r.liking).filter(num);
    const dl = parseFloat(t.dlScore);
    const kegMean = mean(likes);
    const drift = num(dl) && kegMean !== null ? kegMean - dl : null;
    const trace = rows
      .filter((r) => num(r.liking))
      .map((r) => ({ x: num(r.ageDays) ? r.ageDays : (daysBetween(t.pkg, r.date) ?? 0), y: r.liking, date: r.date }))
      .sort((a, b) => a.x - b.x);

    return {
      tap: t,
      checks: kegChecks,
      allChecks: all,
      last, prev, verdict, status, fresh, drift, trace,
      dl: num(dl) ? dl : null,
      n: rows.length,
      kegMean,
      sd: sd(likes),
      lastDate: last ? last.date : null,
      sinceCheck: last ? daysSince(last.date) : null,
      ttbFailRate: rows.length ? rows.filter((r) => r.ttb === "no").length / rows.length : null,
    };
  }).sort((a, b) => a.tap.line - b.tap.line);

  const statsById = Object.fromEntries(tapStats.map((s) => [s.tap.id, s]));
  const activeStats = tapStats.filter((s) => s.tap.active && !s.tap.onDeck);
  const covered = activeStats.filter((s) => s.sinceCheck !== null && s.sinceCheck <= settings.coverageDays);
  const coverage = activeStats.length ? covered.length / activeStats.length : 0;
  const due = activeStats.filter((s) => s.sinceCheck === null || s.sinceCheck > settings.coverageDays);
  const flagged = activeStats.filter((s) => s.tap.flag);

  /* Brand freshness curves, pooled across every keg of that brand. */
  const byBrand = {};
  for (const r of results) {
    const t = tapById[r.tapId];
    if (!t || !t.brand) continue;
    (byBrand[t.brand] ||= []).push({ r, t });
  }
  const brandCurves = Object.entries(byBrand).map(([brand, arr]) => {
    const pts = arr.filter(({ r }) => num(r.ageDays) && num(r.liking)).map(({ r }) => ({ x: r.ageDays, y: r.liking }));
    const fit = ols(pts);
    let crossDays = null;
    if (fit && fit.slope < -0.002) {
      crossDays = Math.round((settings.likingPass - fit.intercept) / fit.slope);
      if (crossDays < 0 || crossDays > 900) crossDays = null;
    }
    const dls = arr.map(({ r }) => parseFloat(r.dlScore)).filter(num);
    return { brand, pts, fit, crossDays, n: pts.length, dl: dls.length ? mean(dls) : null, mean: mean(pts.map((p) => p.y)) };
  }).sort((a, b) => b.n - a.n);

  /* Line report card. A line is hardware; a tap is what is on it today. */
  const byLine = {};
  for (const r of results) {
    const t = tapById[r.tapId];
    if (!t) continue;
    (byLine[t.line] ||= []).push({ r, t });
  }
  /* A line is measured against the rest of the wall, not against the house
     average that includes it. A bad line pours a lot of beer, and letting its
     own scores into the baseline is what buries it: nine bad samples out of
     twenty drag the average down far enough that the line looks ordinary. */
  const allLikes = results.map((r) => r.liking).filter(num);
  const grandSum = allLikes.reduce((x, y) => x + y, 0);
  const grandN = allLikes.length;
  const lineStats = Object.entries(byLine).map(([line, arr]) => {
    const likes = arr.map(({ r }) => r.liking).filter(num);
    const brands = new Set(arr.map(({ t }) => t.brand).filter(Boolean));
    const lineFaults = arr.flatMap(({ r }) => (r.faults || []).filter((f) => {
      const d = FAULT_BY_ID[f.id];
      return d && (d.origin === "L" || d.origin === "BL");
    }));
    const m = mean(likes);
    const restN = grandN - likes.length;
    const restMean = restN > 0 ? (grandSum - likes.reduce((x, y) => x + y, 0)) / restN : null;
    const delta = m !== null && restMean !== null ? m - restMean : null;
    return {
      line: Number(line), n: likes.length, brands: brands.size, brandNames: [...brands],
      mean: m, restMean, delta, lineFaults: lineFaults.length,
      thin: likes.length < 5,
      suspect: likes.length >= 5 && brands.size >= 2 && delta !== null && delta <= -0.8,
      confounded: likes.length >= 5 && brands.size === 1 && delta !== null && delta <= -0.8,
    };
  }).sort((a, b) => (a.thin ? 1 : 0) - (b.thin ? 1 : 0) || (a.delta ?? 99) - (b.delta ?? 99));

  /* Panelist calibration. Bias is distance from the rest of the panel on the
     same beer on the same day. It is a description, not a grade. */
  const cell = {};
  for (const r of results) (cell[`${r.tapId}|${r.date}`] ||= []).push(r);
  const byTaster = {};
  for (const r of results) (byTaster[r.tasterId] ||= []).push(r);
  const tasterStats = Object.entries(byTaster).map(([tasterId, rows]) => {
    const likes = rows.map((r) => r.liking).filter(num);
    const deltas = rows.map((r) => {
      const peers = (cell[`${r.tapId}|${r.date}`] || []).filter((p) => p.tasterId !== tasterId && num(p.liking));
      if (!peers.length || !num(r.liking)) return null;
      return r.liking - mean(peers.map((p) => p.liking));
    }).filter((x) => x !== null);
    const bias = mean(deltas);
    return {
      tasterId, n: likes.length, mean: mean(likes), sd: sd(likes), bias,
      paired: deltas.length,
      severity: bias === null ? null : bias > 0.35 ? "lenient" : bias < -0.35 ? "severe" : "aligned",
      faultRate: rows.length ? rows.filter((r) => (r.faults || []).length).length / rows.length : null,
      notTrueRate: rows.length ? rows.filter((r) => r.ttb === "no").length / rows.length : null,
      lastDate: rows.map((r) => r.date).sort().slice(-1)[0] || null,
    };
  }).sort((a, b) => b.n - a.n);

  /* Fault pareto, weighted by intensity rather than raw count: one sample at
     5 matters more than three at 1. */
  const faultAgg = {};
  for (const r of results) {
    for (const f of r.faults || []) {
      const a = (faultAgg[f.id] ||= { id: f.id, n: 0, sumI: 0, taps: new Set(), lines: new Set(), days: new Set(), maxI: 0 });
      a.n++; a.sumI += f.i;
      a.taps.add(r.tapId);
      if (num(r.line)) a.lines.add(r.line);
      a.days.add(r.date);
      a.maxI = Math.max(a.maxI, f.i);
    }
  }
  const pareto = Object.values(faultAgg).map((f) => ({
    ...f, def: FAULT_BY_ID[f.id], taps: f.taps.size, lines: f.lines.size, days: f.days.size,
    avgI: f.sumI / f.n, weight: f.sumI,
  })).sort((a, b) => b.weight - a.weight);

  return {
    tapById, statsById, tapStats, activeStats, checks, checksByTap,
    coverage, due, flagged, houseMean, brandCurves, lineStats, tasterStats, pareto,
  };
}

/* ==========================================================================
   SIGNALS — section 8 of the SOP, running continuously
   The rule is about pattern, not intensity. One fault on four taps in one
   morning is a gas problem. The same fault on one line for three weeks is a
   biofilm. The same brand falling over on two different lines is a brewery
   problem, and no amount of line cleaning will fix it.
   ========================================================================== */
function buildSignals(a, taps, results, settings) {
  const out = [];
  const win = settings.signalWindow || 21;
  const cutoff = shiftISO(todayISO(), -win);
  const recent = results.filter((r) => r.date >= cutoff);
  const tapById = a.tapById;
  const lineOf = (r) => (tapById[r.tapId] ? tapById[r.tapId].line : r.line);

  /* 1 — one fault, two or more taps, same day. System-side until proven
        otherwise: gas, temperature, or the cleaning schedule. */
  const dayFault = {};
  for (const r of recent) {
    for (const f of r.faults || []) {
      const k = `${r.date}|${f.id}`;
      (dayFault[k] ||= { date: r.date, fault: f.id, taps: new Set(), lines: new Set(), maxI: 0 });
      dayFault[k].taps.add(r.tapId);
      if (lineOf(r) !== undefined) dayFault[k].lines.add(lineOf(r));
      dayFault[k].maxI = Math.max(dayFault[k].maxI, f.i);
    }
  }
  const systemHits = Object.values(dayFault)
    .filter((d) => d.taps.size >= 2)
    .sort((x, y) => y.date.localeCompare(x.date));
  for (const d of systemHits.slice(0, 2)) {
    const def = FAULT_BY_ID[d.fault];
    out.push({
      id: `sys-${d.date}-${d.fault}`,
      sev: d.maxI >= settings.faultInvestigate ? "pull" : "watch",
      mark: "8.1",
      title: `${def ? def.label : d.fault} on ${d.taps.size} taps at once`,
      detail: `Lines ${[...d.lines].sort((x, y) => x - y).join(", ")} on ${fmtDate(d.date)}. One fault across several taps in a single session points at something shared, not at any one keg.`,
      doThis: "Check gas blend and pressure, walk-in and trunk-line temperature, and the line-cleaning record before touching a keg.",
      lines: [...d.lines],
    });
  }

  /* 2 — one fault, one line, on separate days. Confounded: the coupler test
        is the only thing that separates beer from line. */
  const lineFault = {};
  for (const r of recent) {
    const ln = lineOf(r);
    for (const f of r.faults || []) {
      const k = `${ln}|${f.id}`;
      (lineFault[k] ||= { line: ln, fault: f.id, days: new Set(), brands: new Set(), maxI: 0 });
      lineFault[k].days.add(r.date);
      const t = tapById[r.tapId];
      if (t && t.brand) lineFault[k].brands.add(t.brand);
      lineFault[k].maxI = Math.max(lineFault[k].maxI, f.i);
    }
  }
  for (const d of Object.values(lineFault).filter((x) => x.days.size >= 2).slice(0, 3)) {
    const def = FAULT_BY_ID[d.fault];
    const inSystem = systemHits.some((s) => s.fault === d.fault && s.lines.has(d.line));
    if (inSystem) continue;
    out.push({
      id: `conf-${d.line}-${d.fault}`,
      sev: def && def.origin === "L" ? "line" : "watch",
      mark: "8.2",
      title: `Line ${d.line} keeps showing ${def ? def.label.toLowerCase() : d.fault}`,
      detail: `${d.days.size} separate sessions${d.brands.size > 1 ? ` across ${d.brands.size} brands` : ""}. On one line only, this is confounded — it could be the beer or the plumbing.`,
      doThis: "Draw one sample at the keg coupler and one at the faucet and taste them side by side. Clean at the coupler and off at the faucet is the line. Off at both is the beer, so pull the retain for that batch.",
      lines: [d.line],
    });
  }

  /* 3 — one line low across two or more brands over time. The line. */
  for (const l of a.lineStats.filter((x) => x.suspect).slice(0, 3)) {
    out.push({
      id: `line-${l.line}`,
      sev: "line",
      mark: "8.3",
      title: `Line ${l.line} runs ${Math.abs(l.delta).toFixed(1)} below the rest of the wall on every brand it pours`,
      detail: `${l.n} scores across ${l.brands} brands (${l.brandNames.slice(0, 3).join(", ")}). When different beers all score low on the same line, the beer is not the variable.`,
      doThis: "Schedule caustic and acid, pull and inspect the faucet and coupler, and check the shank for a warm spot.",
      lines: [l.line],
    });
  }

  /* 4 — one brand low across two or more lines. The brewery. */
  const brandLine = {};
  for (const r of recent) {
    const t = tapById[r.tapId];
    if (!t || !t.brand || !num(r.liking)) continue;
    const b = (brandLine[t.brand] ||= { brand: t.brand, lines: {}, all: [] });
    (b.lines[t.line] ||= []).push(r.liking);
    b.all.push(r.liking);
  }
  for (const b of Object.values(brandLine)) {
    const lines = Object.entries(b.lines).filter(([, v]) => v.length >= 2);
    if (lines.length < 2 || b.all.length < 4) continue;
    const m = mean(b.all);
    const allLow = lines.every(([, v]) => mean(v) < settings.likingPass);
    if (m < settings.likingPass - 0.3 && allLow) {
      out.push({
        id: `brand-${b.brand}`,
        sev: "pull",
        mark: "8.4",
        title: `${b.brand} is scoring ${m.toFixed(1)} on ${lines.length} different lines`,
        detail: `Every line it touches scores it below ${settings.likingPass}. A brand that fails on more than one line has arrived that way.`,
        doThis: "This one is on the brewery. Check packaging DO, the cellar tank, and the fill date, and pull the retain for the batch.",
        lines: lines.map(([k]) => Number(k)),
      });
    }
  }

  /* 5 — kegs past code or nearly there. */
  const expired = a.activeStats.filter((s) => s.fresh.state === "expired");
  const risk = a.activeStats.filter((s) => s.fresh.state === "code-risk");
  if (expired.length) {
    out.push({
      id: "code-expired",
      sev: "pull",
      mark: "7",
      title: `${expired.length} ${expired.length === 1 ? "keg is" : "kegs are"} past code`,
      detail: expired.map((s) => `Line ${s.tap.line} ${s.tap.brand} at day ${s.fresh.age} of ${s.fresh.shelf}`).join(" · "),
      doThis: "Pull it, or document an exception and put a tasting behind it.",
      lines: expired.map((s) => s.tap.line),
    });
  }
  if (risk.length) {
    out.push({
      id: "code-risk",
      sev: "watch",
      mark: "7",
      title: `${risk.length} ${risk.length === 1 ? "keg is" : "kegs are"} inside the last 15% of code`,
      detail: risk.map((s) => `Line ${s.tap.line} ${s.tap.brand}, ${s.fresh.left}d left`).join(" · "),
      doThis: "Put these at the front of the next flight and plan the changeover.",
      lines: risk.map((s) => s.tap.line),
    });
  }

  /* 6 — drift from the DraughtLab release score. The whole point of the
        program: what the four feet of tubing did to a beer that left the
        cellar clean. */
  for (const s of a.activeStats) {
    if (s.drift === null || s.n < 3) continue;
    if (s.drift <= -(settings.driftAlert || 1)) {
      out.push({
        id: `drift-${s.tap.id}`,
        sev: "watch",
        mark: "1",
        title: `Line ${s.tap.line} ${s.tap.brand} is ${Math.abs(s.drift).toFixed(1)} below its release score`,
        detail: `DraughtLab passed this batch at ${s.dl.toFixed(1)}. The bar is scoring it ${s.kegMean.toFixed(1)} over ${s.n} samples${s.fresh.age !== null ? ` at day ${s.fresh.age}` : ""}. Whatever happened, happened after the cellar.`,
        doThis: "Compare a coupler pour to a faucet pour, then check dispense temperature and the age on the keg.",
        lines: [s.tap.line],
      });
    }
  }

  /* 7 — coverage and flags. Quiet, but they are what the rotation is for. */
  if (a.flagged.length) {
    out.push({
      id: "flags",
      sev: "watch",
      mark: "10",
      title: `${a.flagged.length} ${a.flagged.length === 1 ? "tap has been flagged" : "taps have been flagged"} and not yet tasted`,
      detail: a.flagged.map((s) => `Line ${s.tap.line} ${s.tap.brand} — ${s.tap.flag.reason}`).join(" · "),
      doThis: "Flagged taps go to the front of the next flight regardless of when they were last checked.",
      lines: a.flagged.map((s) => s.tap.line),
    });
  }
  const stale = a.due.filter((s) => s.sinceCheck !== null && s.sinceCheck > settings.coverageDays * 2);
  if (stale.length) {
    out.push({
      id: "stale",
      sev: "info",
      mark: "3",
      title: `${stale.length} ${stale.length === 1 ? "tap has" : "taps have"} gone more than ${settings.coverageDays * 2} days without a check`,
      detail: stale.slice(0, 6).map((s) => `Line ${s.tap.line} ${s.tap.brand} (${fmtAgo(s.sinceCheck)})`).join(" · "),
      doThis: "Every active line is supposed to be evaluated at least once every " + settings.coverageDays + " days.",
      lines: stale.map((s) => s.tap.line),
    });
  }

  const rank = { pull: 0, line: 1, watch: 2, info: 3 };
  return out.sort((x, y) => (rank[x.sev] ?? 9) - (rank[y.sev] ?? 9));
}

/* A session, in a form you can paste into a group text. */
function sessionSummaryText(rows, taps, tasters, settings, a) {
  const tapById = Object.fromEntries(taps.map((t) => [t.id, t]));
  const who = [...new Set(rows.map((r) => r.tasterId))]
    .map((id) => (tasters.find((t) => t.id === id) || {}).name || "?")
    .join(", ");
  const byTap = {};
  for (const r of rows) (byTap[r.tapId] ||= []).push(r);
  const lines = [
    `Line Check — ${fmtDate(todayISO())}`,
    `${Object.keys(byTap).length} taps, ${rows.length} scores, tasted by ${who}`,
    "",
  ];
  const flagged = [];
  for (const [tapId, rs] of Object.entries(byTap)) {
    const t = tapById[tapId] || {};
    const m = mean(rs.map((r) => r.liking).filter(num));
    const worst = rs.flatMap((r) => r.faults || []).reduce((x, f) => (x === null || f.i > x.i ? f : x), null);
    const calls = [...new Set(rs.map((r) => r.action))];
    const tag = calls.some((c) => c && c.startsWith("pull")) ? "PULL" : calls.includes("watch") ? "WATCH" : "ok";
    const bit = `${String(t.line).padStart(2, "0")} ${t.brand} — ${m === null ? "—" : m.toFixed(1)}${worst ? ` · ${FAULT_BY_ID[worst.id] ? FAULT_BY_ID[worst.id].label : worst.id} ${worst.i}/5` : ""} · ${tag}`;
    if (tag === "ok") lines.push(bit); else flagged.push(bit);
  }
  if (flagged.length) {
    lines.push("", "Needs action:");
    flagged.forEach((f) => lines.push(f));
  }
  return lines.join("\n");
}

/* ==========================================================================
   PRIMITIVES
   ========================================================================== */

/* The drift trace. Every tap on the wall carries one: the release score as a
   dashed baseline, then every bar score since, plotted against keg age. The
   shape of the gap is the program's entire thesis in 96 pixels. */
function Trace({ trace, dl, pass, w = 96, h = 30, status }) {
  if (!trace || trace.length === 0) {
    return <div className="lc-mono" style={{ fontSize: 9, color: "var(--faint)", textAlign: "center" }}>no data</div>;
  }
  const P = { l: 2, r: 3, t: 4, b: 4 };
  const maxX = Math.max(14, ...trace.map((p) => p.x));
  const X = (v) => P.l + (maxX ? (v / maxX) : 0) * (w - P.l - P.r);
  const Y = (v) => P.t + (1 - (clamp(v, 1, 9) - 1) / 8) * (h - P.t - P.b);
  const col = status === "pull" ? "var(--pull)" : status === "watch" ? "var(--watch)" : status === "pass" ? "var(--pass)" : "var(--head)";
  const path = trace.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const last = trace[trace.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      {num(pass) && <line x1={P.l} x2={w - P.r} y1={Y(pass)} y2={Y(pass)} stroke="var(--shank)" strokeWidth="1" />}
      {num(dl) && (
        <>
          <line x1={P.l} x2={w - P.r} y1={Y(dl)} y2={Y(dl)} stroke="var(--dim)" strokeWidth="1" strokeDasharray="2 3" opacity="0.85" />
          <circle cx={P.l} cy={Y(dl)} r="1.8" fill="var(--dim)" />
        </>
      )}
      {trace.length > 1 && <path d={path} fill="none" stroke={col} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />}
      {trace.map((p, i) => (
        <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={i === trace.length - 1 ? 2.4 : 1.5} fill={i === trace.length - 1 ? col : "var(--head)"} opacity={i === trace.length - 1 ? 1 : 0.5} />
      ))}
      {num(dl) && last && (
        <line x1={X(last.x)} x2={X(last.x)} y1={Y(dl)} y2={Y(last.y)} stroke={col} strokeWidth="1" opacity="0.35" />
      )}
    </svg>
  );
}

function FreshBar({ tap, settings, compact }) {
  const f = freshness(tap, settings);
  if (f.frac === null) {
    return (
      <div>
        <div className="fresh"><i style={{ width: "100%", background: "var(--shank)" }} /></div>
        <div className="fresh-lab"><span>no package date</span><span>{f.shelf}d code</span></div>
      </div>
    );
  }
  const pct = Math.min(100, f.frac * 100);
  const c = freshColor(f.frac);
  return (
    <div>
      <div className="fresh" title={`Day ${f.age} of a ${f.shelf} day code`}>
        <i style={{ width: `${pct}%`, background: c }} />
      </div>
      <div className="fresh-lab">
        <span>{compact ? `d${f.age}` : `${fmtDate(tap.pkg)} · day ${f.age}`}</span>
        <span style={{ color: f.state === "fresh" ? "var(--dim)" : c }}>
          {f.left >= 0 ? `${f.left}d left` : `${-f.left}d over`}
        </span>
      </div>
    </div>
  );
}

function Scatter({ curve, settings, w = 340, h = 150 }) {
  const P = { l: 24, r: 10, t: 10, b: 22 };
  const pts = curve.pts;
  if (!pts.length) return null;
  const maxX = Math.max(30, ...pts.map((p) => p.x), curve.crossDays || 0) * 1.06;
  const X = (v) => P.l + (v / maxX) * (w - P.l - P.r);
  const Y = (v) => P.t + (1 - (clamp(v, 1, 9) - 1) / 8) * (h - P.t - P.b);
  const fit = curve.fit;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }} role="img" aria-label={`Liking against keg age for ${curve.brand}`}>
      {[1, 3, 5, 7, 9].map((g) => (
        <g key={g}>
          <line x1={P.l} x2={w - P.r} y1={Y(g)} y2={Y(g)} stroke="var(--shank)" strokeWidth="1" opacity="0.7" />
          <text x={P.l - 6} y={Y(g) + 3} fill="var(--faint)" fontSize="8" fontFamily="IBM Plex Mono, monospace" textAnchor="end">{g}</text>
        </g>
      ))}
      <line x1={P.l} x2={w - P.r} y1={Y(settings.likingPass)} y2={Y(settings.likingPass)} stroke="var(--watch)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
      {num(curve.dl) && <line x1={P.l} x2={w - P.r} y1={Y(curve.dl)} y2={Y(curve.dl)} stroke="var(--dim)" strokeWidth="1" strokeDasharray="1 4" />}
      {fit && (
        <line
          x1={X(0)} y1={Y(clamp(fit.intercept, 1, 9))}
          x2={X(maxX)} y2={Y(clamp(fit.intercept + fit.slope * maxX, 1, 9))}
          stroke="var(--foam)" strokeWidth="1.4" opacity="0.85"
        />
      )}
      {curve.crossDays && curve.crossDays <= maxX && (
        <>
          <line x1={X(curve.crossDays)} x2={X(curve.crossDays)} y1={P.t} y2={h - P.b} stroke="var(--pull)" strokeWidth="1" strokeDasharray="2 3" />
          <text x={X(curve.crossDays) + 4} y={P.t + 9} fill="var(--pull)" fontSize="8" fontFamily="IBM Plex Mono, monospace">d{curve.crossDays}</text>
        </>
      )}
      {pts.map((p, i) => <circle key={i} cx={X(p.x)} cy={Y(p.y)} r="2.6" fill="var(--foam)" opacity="0.6" />)}
      <text x={w - P.r} y={h - 5} fill="var(--faint)" fontSize="8" fontFamily="IBM Plex Mono, monospace" textAnchor="end">days since package</text>
    </svg>
  );
}

function Sheet({ children, onClose, title, sub }) {
  useEffect(() => {
    const k = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [onClose]);
  return (
    <div className="scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-h">
          <div style={{ minWidth: 0 }}>
            <b>{title}</b>
            {sub && <div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>{sub}</div>}
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function useToast() {
  const [msg, setMsg] = useState(null);
  const t = useRef(null);
  const show = useCallback((m) => {
    setMsg(m);
    clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 2200);
  }, []);
  useEffect(() => () => clearTimeout(t.current), []);
  const node = msg ? <div className="toast" role="status">{msg}</div> : null;
  return [node, show];
}

const initials = (name) => (name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

function Who({ tasters, ids }) {
  if (!tasters.length) return null;
  return (
    <div className="who">
      {tasters.map((t) => (
        <div key={t.id} className="av" data-on={ids.includes(t.id) ? "1" : "0"} title={`${t.name}${ids.includes(t.id) ? " — scored" : " — not yet"}`}>
          {initials(t.name)}
        </div>
      ))}
    </div>
  );
}

function Empty({ title, body, action }) {
  return (
    <div className="empty">
      <b>{title}</b>
      <p>{body}</p>
      {action}
    </div>
  );
}

/* ==========================================================================
   THE WALL
   ========================================================================== */

function todaysFlight() {
  const d = new Date().getDay();
  return FLIGHTS.find((f) => f.day === d) || null;
}
function nextFlight() {
  const d = new Date().getDay();
  for (let i = 1; i <= 7; i++) {
    const hit = FLIGHTS.find((f) => f.day === (d + i) % 7);
    if (hit) return { flight: hit, inDays: i };
  }
  return null;
}

function Wall({ a, taps, tasters, settings, results, signals, me, onStart, api, toast }) {
  const [qtext, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("line");
  const [openTapId, setOpenTap] = useState(null);
  const [flagTapId, setFlagTap] = useState(null);
  const [allSignals, setAllSignals] = useState(false);

  const today = todaysFlight();
  const upNext = nextFlight();
  const flightPool = today
    ? a.activeStats.filter((s) => today.groups.includes(s.tap.style))
    : [];
  const flightDue = flightPool.filter((s) => s.sinceCheck === null || s.sinceCheck > settings.coverageDays);

  const rows = useMemo(() => {
    let list = a.tapStats.filter((s) => s.tap.active);
    if (filter === "deck") list = list.filter((s) => s.tap.onDeck);
    else list = list.filter((s) => !s.tap.onDeck);
    if (filter === "due") list = list.filter((s) => s.sinceCheck === null || s.sinceCheck > settings.coverageDays);
    if (filter === "action") list = list.filter((s) => s.status === "watch" || s.status === "pull");
    if (filter === "flag") list = list.filter((s) => s.tap.flag);
    const q = qtext.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        s.tap.brand.toLowerCase().includes(q) ||
        s.tap.style.toLowerCase().includes(q) ||
        String(s.tap.line) === q);
    }
    const by = {
      line: (x, y) => x.tap.line - y.tap.line,
      score: (x, y) => (x.last ? x.last.mean : 99) - (y.last ? y.last.mean : 99),
      age: (x, y) => (y.fresh.frac ?? -1) - (x.fresh.frac ?? -1),
      stale: (x, y) => (y.sinceCheck ?? 999) - (x.sinceCheck ?? 999),
    };
    return list.slice().sort(by[sort] || by.line);
  }, [a.tapStats, filter, qtext, sort, settings.coverageDays]);

  const shownSignals = allSignals ? signals : signals.slice(0, 4);
  const openStat = openTapId ? a.statsById[openTapId] : null;
  const flagStat = flagTapId ? a.statsById[flagTapId] : null;

  return (
    <div>
      {/* ---- today's assignment ---- */}
      <div className="hero">
        <div className="hero-top">
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">{today ? `${today.dayLabel} · ${today.label}` : "Off rotation"}</div>
            <h1 className="hero-day" style={{ color: "var(--foam)" }}>
              {today ? today.groups.join(" & ") : upNext ? `${upNext.flight.label} in ${upNext.inDays} ${upNext.inDays === 1 ? "day" : "days"}` : "No flight scheduled"}
            </h1>
            <p className="hero-sub">
              {today && flightPool.length === 0
                ? <>Nothing on the wall matches this flight right now. {a.due.length ? `${a.due.length} ${a.due.length === 1 ? "tap is" : "taps are"} overdue if you want to use the slot.` : "Every active line is inside its window."}</>
                : today
                ? <>{flightPool.length} {flightPool.length === 1 ? "tap" : "taps"} on the wall for this flight{flightDue.length ? <>, {flightDue.length} of them overdue</> : ", all current"}. {today.note}</>
                : <>Nothing scheduled today. {a.due.length ? `${a.due.length} ${a.due.length === 1 ? "tap is" : "taps are"} past the ${settings.coverageDays} day window if you want to catch up.` : "Every active line is inside its window."}</>}
            </p>
          </div>
          <div className="hero-cta">
            <button className="btn btn-lg" data-p="1" onClick={() => onStart(today && flightPool.length ? today.id : "due")}>
              {today && flightPool.length ? `Taste ${today.label}` : a.due.length ? "Taste what's overdue" : "Start a session"}
            </button>
            {today && flightPool.length > 0 && flightDue.length > 0 && (
              <button className="btn btn-sm" data-ghost="1" onClick={() => onStart("due")}>
                Overdue only ({a.due.length})
              </button>
            )}
          </div>
        </div>
        <div className="hero-meta">
          <div className="stat">
            <b style={{ color: a.coverage >= 0.9 ? "var(--pass)" : a.coverage >= 0.6 ? "var(--watch)" : "var(--pull)" }}>
              {Math.round(a.coverage * 100)}%
            </b>
            <span>{settings.coverageDays}-day coverage</span>
          </div>
          <div className="stat">
            <b style={{ color: a.due.length ? "var(--watch)" : "var(--pass)" }}>{a.due.length}</b>
            <span>taps due</span>
          </div>
          <div className="stat">
            <b>{a.houseMean === null ? "\u2014" : a.houseMean.toFixed(2)}</b>
            <span>house mean</span>
          </div>
          <div className="stat">
            <b style={{ color: signals.filter((s) => s.sev === "pull").length ? "var(--pull)" : "inherit" }}>{signals.length}</b>
            <span>open signals</span>
          </div>
        </div>
      </div>

      {/* ---- signals ---- */}
      {signals.length > 0 && (
        <div className="sec">
          <div className="h">
            What the data is telling you
            <button className="btn btn-sm" data-ghost="1" onClick={() => setAllSignals(!allSignals)}>
              {allSignals ? "Show top 4" : `All ${signals.length}`}
            </button>
          </div>
          <div className="stack stagger">
            {shownSignals.map((s, i) => (
              <div className="sig" data-sev={s.sev} key={s.id} style={{ animationDelay: `${i * 40}ms` }}>
                <div className="sig-ic">{s.mark}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="sig-t">{s.title}</div>
                  <div className="sig-d">{s.detail}</div>
                  <div className="sig-do"><b>Do this</b>{s.doThis}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- the wall ---- */}
      <div className="sec">
        <div className="h">The wall</div>
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            value={qtext} onChange={(e) => setQ(e.target.value)}
            placeholder="Find a brand, style, or line number"
            style={{ maxWidth: 260 }} aria-label="Search the tap wall"
          />
          <div className="seg" role="group" aria-label="Filter">
            {[["all", "All"], ["due", "Due"], ["action", "Watch"], ["flag", "Flagged"], ["deck", "On deck"]].map(([k, l]) => (
              <button key={k} data-on={filter === k ? "1" : "0"} onClick={() => setFilter(k)} aria-pressed={filter === k}>{l}</button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Sort" style={{ marginLeft: "auto" }}>
            {[["line", "Line"], ["score", "Score"], ["age", "Age"], ["stale", "Stalest"]].map(([k, l]) => (
              <button key={k} data-on={sort === k ? "1" : "0"} onClick={() => setSort(k)} aria-pressed={sort === k}>{l}</button>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty
            title={taps.length ? "Nothing matches" : "The wall is empty"}
            body={taps.length
              ? "Try a different filter, or clear the search."
              : "Add your taps one at a time, or paste the whole list in at once. The Taps tab has both."}
            action={null}
          />
        ) : (
          <div className="wall">
            <div className="wall-head">
              <span>Line</span><span>Brand</span><span>Since release</span><span>Last</span><span>Keg age</span>
            </div>
            {rows.map((s) => (
              <button className="wrow" data-s={s.status} key={s.tap.id} onClick={() => setOpenTap(s.tap.id)}>
                <div className="wrow-n">{String(s.tap.line).padStart(2, "0")}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="wrow-name">{s.tap.brand || <span className="dim">Untitled tap</span>}</div>
                  <div className="wrow-sub">
                    <span>{s.tap.style}</span>
                    {s.dl !== null && <span>DL {s.dl.toFixed(1)}</span>}
                    {s.tap.flag && <span className="chip" data-t="watch">flagged</span>}
                    {(s.sinceCheck === null || s.sinceCheck > settings.coverageDays) && <span className="chip" data-t="info">due</span>}
                    {s.last && s.sinceCheck !== null && <span>{fmtAgo(s.sinceCheck)}</span>}
                  </div>
                </div>
                <div className="wrow-trace">
                  <Trace trace={s.trace} dl={s.dl} pass={settings.likingPass} status={s.status} />
                </div>
                <div className="wrow-score" style={{
                  color: s.last === null ? "var(--faint)"
                    : s.status === "pull" ? "var(--pull)" : s.status === "watch" ? "var(--watch)" : "var(--pass)",
                }}>
                  {s.last && s.last.mean !== null ? s.last.mean.toFixed(1) : "\u2014"}
                  <small>{s.last ? `n=${s.last.n}` : "new keg"}</small>
                </div>
                <div className="wrow-fresh"><FreshBar tap={s.tap} settings={settings} /></div>
              </button>
            ))}
          </div>
        )}
      </div>

      {openStat && (
        <KegSheet
          s={openStat} a={a} settings={settings} tasters={tasters} results={results}
          onClose={() => setOpenTap(null)}
          onFlag={() => { setFlagTap(openStat.tap.id); setOpenTap(null); }}
          onClearFlag={async () => { await api.saveTap({ ...openStat.tap, flag: null }); toast("Flag cleared"); }}
          onTasteNow={() => { setOpenTap(null); onStart("one:" + openStat.tap.id); }}
          onNewKeg={async (pkg) => {
            await api.saveTap({ ...openStat.tap, pkg, flag: null });
            toast("New keg logged");
          }}
          onDeleteResult={async (id) => { await api.deleteResult(id); toast("Score deleted"); }}
        />
      )}

      {flagStat && (
        <Sheet title={`Flag line ${flagStat.tap.line}`} sub={flagStat.tap.brand} onClose={() => setFlagTap(null)}>
          <p className="lede">A flag moves this tap to the front of the next flight. No score, no scale — just say what is wrong.</p>
          <div className="fchips">
            {FLAG_REASONS.map((r) => (
              <button className="fchip" key={r} onClick={async () => {
                await api.saveTap({
                  ...flagStat.tap,
                  flag: { reason: r, by: me ? me.name : "someone", at: new Date().toISOString(), date: todayISO() },
                });
                setFlagTap(null);
                toast("Flagged");
              }}>{r}</button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function KegSheet({ s, a, settings, tasters, results, onClose, onFlag, onClearFlag, onTasteNow, onNewKeg, onDeleteResult }) {
  const [newPkg, setNewPkg] = useState("");
  const [showNew, setShowNew] = useState(false);
  const t = s.tap;
  const nameOf = (id) => (tasters.find((x) => x.id === id) || {}).name || "Unknown";
  const curve = { brand: t.brand, pts: s.trace, fit: ols(s.trace), crossDays: null, dl: s.dl, n: s.trace.length };

  /* Kegs before this one, so a package date change never hides history. */
  const priorKegs = useMemo(() => {
    const map = {};
    for (const r of results.filter((r) => r.tapId === t.id && (r.pkg || "") !== (t.pkg || ""))) {
      const k = r.pkg || "no date";
      (map[k] ||= { pkg: k, likes: [], dates: [] });
      if (num(r.liking)) map[k].likes.push(r.liking);
      map[k].dates.push(r.date);
    }
    return Object.values(map).map((k) => ({
      pkg: k.pkg, n: k.likes.length, mean: mean(k.likes),
      from: k.dates.sort()[0], to: k.dates.sort().slice(-1)[0],
    })).sort((x, y) => (y.from || "").localeCompare(x.from || ""));
  }, [results, t.id, t.pkg]);

  return (
    <Sheet title={t.brand || "Untitled tap"} sub={`Line ${t.line} · ${t.style}`} onClose={onClose}>
      <div className="verd" style={{ marginBottom: 14 }}>
        <div style={{
          fontFamily: "var(--gauge)", fontSize: 30, fontWeight: 600, lineHeight: 1, minWidth: 46,
          color: s.status === "pull" ? "var(--pull)" : s.status === "watch" ? "var(--watch)" : s.status === "pass" ? "var(--pass)" : "var(--faint)",
        }}>
          {s.last && s.last.mean !== null ? s.last.mean.toFixed(1) : "\u2014"}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="verd-k">The limits say</div>
          <div className="verd-v" style={{
            color: s.verdict.level === "pull" ? "var(--pull)" : s.verdict.level === "investigate" || s.verdict.level === "watch" ? "var(--watch)" : s.verdict.level === "pass" ? "var(--pass)" : "var(--head)",
          }}>{s.verdict.label}</div>
          <div className="verd-w">{s.verdict.why}</div>
        </div>
      </div>

      {s.trace.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <span className="eyebrow">This keg, score against age</span>
            {s.drift !== null && (
              <span className="chip" data-t={s.drift <= -1 ? "pull" : s.drift < -0.4 ? "watch" : "pass"} style={{ marginLeft: "auto" }}>
                {s.drift > 0 ? "+" : ""}{s.drift.toFixed(1)} vs release
              </span>
            )}
          </div>
          <Scatter curve={curve} settings={settings} h={140} />
          {s.dl !== null && (
            <div className="dim" style={{ fontSize: 11.5, marginTop: 4 }}>
              Dotted line is the DraughtLab release score of {s.dl.toFixed(1)}. The gap below it is what the tap wall did.
            </div>
          )}
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <div className="kv"><span>Packaged</span><b className="lc-mono">{fmtDate(t.pkg)}</b></div>
        <div className="kv"><span>Keg age</span>
          <b className="lc-mono" style={{ color: freshColor(s.fresh.frac) }}>
            {s.fresh.age === null ? "\u2014" : `day ${s.fresh.age} of ${s.fresh.shelf}`}
          </b>
        </div>
        <div className="kv"><span>Release score</span><b className="lc-mono">{s.dl === null ? "not set" : s.dl.toFixed(1)}</b></div>
        <div className="kv"><span>Bar mean, this keg</span><b className="lc-mono">{s.kegMean === null ? "\u2014" : s.kegMean.toFixed(2)}</b></div>
        <div className="kv"><span>Samples / spread</span><b className="lc-mono">{s.n} / {s.sd === null ? "\u2014" : s.sd.toFixed(2)}</b></div>
        <div className="kv"><span>Last checked</span><b className="lc-mono">{s.lastDate ? `${fmtDate(s.lastDate)} · ${fmtAgo(s.sinceCheck)}` : "never"}</b></div>
        {t.flag && <div className="kv"><span>Flag</span><b style={{ color: "var(--watch)" }}>{t.flag.reason} — {t.flag.by}, {fmtDate(t.flag.date)}</b></div>}
      </div>

      {s.checks.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="h">Every check on this keg</div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Day</th><th>Panel</th><th>Scores</th><th>Faults</th></tr></thead>
              <tbody>
                {s.checks.map((c) => (
                  <tr key={c.key}>
                    <td className="n">{fmtDate(c.date)}</td>
                    <td className="n dim">{c.ageDays === null ? "\u2014" : `d${c.ageDays}`}</td>
                    <td className="n" style={{ color: c.mean === null ? "var(--dim)" : c.mean < settings.likingWatch ? "var(--pull)" : c.mean < settings.likingPass ? "var(--watch)" : "var(--pass)" }}>
                      <b>{c.mean === null ? "\u2014" : c.mean.toFixed(1)}</b>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {c.rows.map((r) => (
                        <div key={r.id} className="dim" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ minWidth: 0 }}>
                            {nameOf(r.tasterId)} <span className="lc-mono" style={{ color: "var(--foam)" }}>{r.liking}</span>
                            {r.ttb === "no" && <span style={{ color: "var(--pull)" }}> not true</span>}
                            {r.ttb === "marginal" && <span style={{ color: "var(--watch)" }}> marginal</span>}
                            {r.action && <span> · {ACTION_BY_V[r.action] ? ACTION_BY_V[r.action].label.toLowerCase() : r.action}</span>}
                          </span>
                          {onDeleteResult && (
                            <button className="rrow-x" style={{ width: 20, height: 20, fontSize: 14, flex: "none" }}
                              aria-label={`Delete ${nameOf(r.tasterId)}'s score of ${r.liking}`}
                              onClick={() => {
                                if (window.confirm(`Delete ${nameOf(r.tasterId)}'s score of ${r.liking} on ${fmtDate(r.date)}?`)) onDeleteResult(r.id);
                              }}>&times;</button>
                          )}
                        </div>
                      ))}
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      {c.faults.length === 0 ? <span className="dim">clean</span> : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {c.faults.map((f, i) => (
                            <span className="chip" key={i} data-t={f.i >= settings.faultPull ? "pull" : f.i >= settings.faultInvestigate ? "watch" : ""}>
                              {FAULT_BY_ID[f.id] ? FAULT_BY_ID[f.id].label.split(" /")[0] : f.id} {f.i}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {priorKegs.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="h">Earlier kegs on this tap</div>
          {priorKegs.map((k) => (
            <div className="kv" key={k.pkg}>
              <span>{k.pkg === "no date" ? "no package date" : fmtDate(k.pkg)}</span>
              <b className="lc-mono">{k.mean === null ? "\u2014" : k.mean.toFixed(2)} <span className="dim">over {k.n}</span></b>
            </div>
          ))}
        </div>
      )}

      {showNew ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Package date on the new keg</div>
          <div className="row">
            <input type="date" value={newPkg} onChange={(e) => setNewPkg(e.target.value)} style={{ maxWidth: 180 }} />
            <button className="btn" data-p="1" disabled={!newPkg} onClick={() => { onNewKeg(newPkg); setShowNew(false); onClose(); }}>
              Log the new keg
            </button>
            <button className="btn" data-ghost="1" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
            The wall stats start clean. Everything above stays in the record and keeps feeding the freshness curve.
          </div>
        </div>
      ) : null}

      <div className="row">
        <button className="btn" data-p="1" onClick={onTasteNow}>Taste this now</button>
        <button className="btn" onClick={() => setShowNew(true)}>New keg</button>
        {t.flag
          ? <button className="btn" onClick={onClearFlag}>Clear flag</button>
          : <button className="btn" onClick={onFlag}>Flag it</button>}
      </div>
    </Sheet>
  );
}

/* ==========================================================================
   THE SESSION
   ========================================================================== */

/* Ascending intensity, always. Within a style band, anything flagged or
   overdue is poured first, because those are the ones you came for. */
function buildPlan(kind, taps, a, customIds, settings) {
  const active = taps.filter((t) => t.active && !t.onDeck);
  let pool = [];
  if (kind === "custom") pool = active.filter((t) => customIds.includes(t.id));
  else if (kind.startsWith("one:")) pool = active.filter((t) => t.id === kind.slice(4));
  else if (kind === "due") {
    pool = active.filter((t) => {
      const s = a.statsById[t.id];
      return !s || s.sinceCheck === null || s.sinceCheck > settings.coverageDays || t.flag;
    });
  } else if (kind === "all") pool = active;
  else {
    const f = FLIGHTS.find((x) => x.id === kind);
    if (!f) return [];
    pool = active.filter((t) => f.groups.includes(t.style));
    const flaggedElsewhere = active.filter((t) => t.flag && !f.groups.includes(t.style));
    pool = pool.concat(flaggedElsewhere);
  }
  const pri = (t) => {
    const s = a.statsById[t.id];
    if (t.flag) return 0;
    if (!s || s.sinceCheck === null || s.sinceCheck > settings.coverageDays) return 1;
    return 2;
  };
  return pool.slice().sort((x, y) =>
    (PALATE_RANK[x.style] ?? 4) - (PALATE_RANK[y.style] ?? 4) ||
    pri(x) - pri(y) ||
    x.line - y.line
  ).map((t) => t.id);
}

const emptyDraft = () => ({ ttb: null, missWhere: [], liking: null, faults: [], jar: {}, action: null, note: "" });

function TasteCard({ tap, stat, taster, draft, set, settings, idx, total, nextTap, peers, tasters, onSubmit, onBack, onSkip }) {
  const [t0] = useState(() => Date.now());
  const [secs, setSecs] = useState(0);
  const [showJar, setShowJar] = useState(false);
  const [stuck, setStuck] = useState(false);
  const sentinel = useRef(null);

  useEffect(() => {
    const iv = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [t0]);

  /* A new sample starts at the top of the card, on the brand. Otherwise you
     submit at the bottom of one beer and land in the middle of the next. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const soft = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try { window.scrollTo({ top: 0, behavior: soft ? "auto" : "smooth" }); } catch { window.scrollTo(0, 0); }
  }, []);

  /* The identity bar condenses once it pins, so the brand stays on screen
     without eating a third of a phone. */
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !sentinel.current) return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), { rootMargin: "-54px 0px 0px 0px" });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, []);

  /* Long brand names have to survive a button label without wrapping it. */
  const brandShort = !tap.brand ? "this tap"
    : tap.brand.length > 20 ? `${tap.brand.slice(0, 19).trim()}\u2026` : tap.brand;

  const toggleFault = (id) => {
    const has = draft.faults.find((f) => f.id === id);
    set({ ...draft, faults: has ? draft.faults.filter((f) => f.id !== id) : [...draft.faults, { id, i: 2 }] });
  };
  const setInt = (id, i) => set({ ...draft, faults: draft.faults.map((f) => (f.id === id ? { ...f, i } : f)) });
  const ready = draft.ttb && num(draft.liking) && draft.action;
  const missing = [
    !draft.ttb && "question 1",
    !num(draft.liking) && "a liking score",
    !draft.action && "a call",
  ].filter(Boolean);

  /* What the limits would say about this score, shown only once the taster
     has committed to a number. It informs the call; it must not anchor it. */
  const hint = useMemo(() => {
    if (!num(draft.liking)) return null;
    const pseudo = {
      mean: draft.liking, n: 1, rows: [draft],
      ttbNo: draft.ttb === "no" ? 1 : 0,
      faults: draft.faults,
      worstFault: draft.faults.reduce((m, f) => (m === null || f.i > m.i ? f : m), null),
    };
    return verdictFor({ check: pseudo, tap, settings, prevCheck: stat ? stat.last : null, fresh: stat ? stat.fresh : null });
  }, [draft, tap, settings, stat]);

  /* Keyboard, for whoever is doing this on a laptop at the end of the bar. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key >= "1" && e.key <= "9") { set({ ...draft, liking: Number(e.key) }); return; }
      const k = e.key.toLowerCase();
      const ttb = TTB.find((o) => o.key === k);
      if (ttb) { set({ ...draft, ttb: ttb.v, missWhere: ttb.v === "yes" ? [] : draft.missWhere }); return; }
      if (e.key === "Enter" && ready) onSubmit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, ready, onSubmit, set]);

  const grouped = [
    { k: "B", label: "Beer-side", items: FAULTS.filter((f) => f.origin === "B") },
    { k: "L", label: "Line-side", items: FAULTS.filter((f) => f.origin === "L") },
    { k: "BL", label: "Could be either", items: FAULTS.filter((f) => f.origin === "BL") },
  ];
  const warmed = secs >= 180;

  return (
    <div className="taste">
      <div ref={sentinel} aria-hidden="true" style={{ height: 1 }} />
      <div className="pour" data-stuck={stuck ? "1" : "0"}>
        <div className="pour-top">
          <div className="pour-line" aria-label={`Line ${tap.line}`}>
            <b>{String(tap.line).padStart(2, "0")}</b>
            <span>line</span>
          </div>
          <div className="pour-id">
            <div className="pour-eye">Now tasting</div>
            <div className="pour-brand">{tap.brand || "Untitled tap"}</div>
            <div className="pour-style">{tap.style || "no style on file"}</div>
            <div className="pour-chips">
              {stat && stat.dl !== null && <span className="chip">release {stat.dl.toFixed(1)}</span>}
              {stat && stat.fresh.age !== null && (
                <span className="chip" style={{ color: freshColor(stat.fresh.frac), borderColor: "var(--shank2)" }}>
                  day {stat.fresh.age} of {stat.fresh.shelf}
                </span>
              )}
              {tap.pkg && <span className="chip">packaged {fmtDate(tap.pkg)}</span>}
              <span className="chip">scoring as {taster.name.split(" ")[0]}</span>
            </div>
          </div>
          <div className="pour-clock">
            <div className="pour-count">{idx + 1} / {total}</div>
            <div className="pour-secs" style={{ color: warmed ? "var(--foam)" : "var(--dim)" }}>
              {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
            </div>
            <div className="pour-warm" style={{ color: warmed ? "var(--watch)" : "var(--faint)" }}>
              {warmed ? "nose it warm" : "cold pass"}
            </div>
          </div>
        </div>
      </div>

      <div className="stack" style={{ gap: 22 }}>
      {(tap.flag || (stat && stat.last) || peers.length > 0) && (
        <div className="stack" style={{ gap: 10 }}>
          {tap.flag && (
            <div className="sig" data-sev="watch">
              <div className="sig-ic">!</div>
              <div>
                <div className="sig-t">Flagged: {tap.flag.reason}</div>
                <div className="sig-d">{tap.flag.by} raised this on {fmtDate(tap.flag.date)}. Submitting a score clears it.</div>
              </div>
            </div>
          )}

          {stat && stat.last && (
            <div className="dim" style={{ fontSize: 12.5 }}>
              Last check on {tap.brand || "this tap"} {fmtAgo(stat.sinceCheck)} came in at <b className="lc-mono" style={{ color: "var(--foam)" }}>{stat.last.mean === null ? "\u2014" : stat.last.mean.toFixed(1)}</b>
              {stat.last.faults.length > 0 && <> with {stat.last.faults.map((f) => FAULT_BY_ID[f.id] ? FAULT_BY_ID[f.id].label.split(" /")[0].toLowerCase() : f.id).join(", ")}</>}.
            </div>
          )}

          {peers.length > 0 && (
            <div className="row" style={{ gap: 10 }}>
              <Who tasters={tasters.filter((t) => t.active)} ids={peers.map((p) => p.tasterId)} />
              <span className="dim" style={{ fontSize: 12 }}>
                {peers.length} {peers.length === 1 ? "score" : "scores"} already in on this one
              </span>
            </div>
          )}
        </div>
      )}

      {/* 1 — true to brand */}
      <div>
        <div className="qhead">
          <span className="qn">1</span>
          <span className="qt">True to {brandShort}</span>
        </div>
        <div className="opts opts-3">
          {TTB.map((o) => (
            <button key={o.v} className="opt" data-on={draft.ttb === o.v ? "1" : "0"} data-t={o.tone}
              aria-pressed={draft.ttb === o.v}
              onClick={() => set({ ...draft, ttb: o.v, missWhere: o.v === "yes" ? [] : draft.missWhere })}>
              <b>{o.label}</b><small>{o.hint}</small>
            </button>
          ))}
        </div>
        {draft.ttb && draft.ttb !== "yes" && (
          <div style={{ marginTop: 10 }}>
            <div className="fgrp-h">Where does it miss</div>
            <div className="fchips">
              {MISS_WHERE.map((m) => (
                <button key={m} className="fchip" data-on={draft.missWhere.includes(m) ? "1" : "0"}
                  aria-pressed={draft.missWhere.includes(m)}
                  onClick={() => set({
                    ...draft,
                    missWhere: draft.missWhere.includes(m) ? draft.missWhere.filter((x) => x !== m) : [...draft.missWhere, m],
                  })}>{m}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 2 — liking */}
      <div>
        <div className="qhead"><span className="qn">2</span><span className="qt">Overall liking</span></div>
        <div className="hed">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
            <button key={n} data-on={draft.liking === n ? "1" : "0"} aria-pressed={draft.liking === n}
              aria-label={`${n}, ${HEDONIC[n]}`} onClick={() => set({ ...draft, liking: n })}>
              <b>{n}</b><span>{HEDONIC_SHORT[n]}</span>
            </button>
          ))}
        </div>
        <div className="hed-lab">
          <span>dislike</span>
          <span style={{ color: "var(--foam)" }}>{num(draft.liking) ? HEDONIC[draft.liking] : ""}</span>
          <span>like</span>
        </div>
      </div>

      {/* 3 — faults */}
      <div>
        <div className="qhead">
          <span className="qn">3</span><span className="qt">Faults</span>
          <span className="qopt">optional · 1 threshold, 5 overwhelming</span>
        </div>
        {grouped.map((g) => (
          <div className="fgrp" key={g.k}>
            <div className="fgrp-h">{g.label}</div>
            <div className="fchips">
              {g.items.map((f) => {
                const sel = draft.faults.find((x) => x.id === f.id);
                if (!sel) {
                  return (
                    <button key={f.id} className="fchip" data-on="0" title={f.cause} aria-pressed={false}
                      onClick={() => toggleFault(f.id)}>{f.label}</button>
                  );
                }
                return (
                  <span className="fsel" key={f.id}>
                    <b>{f.label}</b>
                    <span className="fint" role="group" aria-label={`${f.label} intensity`}>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <button key={i} data-on={sel.i === i ? "1" : "0"} data-hi={i >= settings.faultPull ? "1" : "0"}
                          aria-pressed={sel.i === i} aria-label={`intensity ${i}`} onClick={() => setInt(f.id, i)}>{i}</button>
                      ))}
                    </span>
                    <button className="fx" onClick={() => toggleFault(f.id)} aria-label={`Remove ${f.label}`}>&times;</button>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
        {draft.faults.some((f) => f.i >= settings.faultInvestigate) && (
          <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
            {draft.faults.filter((f) => f.i >= settings.faultInvestigate).map((f) => FAULT_BY_ID[f.id] && FAULT_BY_ID[f.id].cause).filter(Boolean).join(" ")}
          </div>
        )}
      </div>

      {/* 4 — just about right */}
      <div>
        <div className="qhead">
          <span className="qn">4</span><span className="qt">Brand character</span>
          <button className="qopt" onClick={() => setShowJar(!showJar)} style={{ cursor: "pointer" }}>
            {showJar ? "hide" : "clean but drifting? open"}
          </button>
        </div>
        {showJar && (
          <div className="card">
            {JAR_ATTRS.map((att) => (
              <div className="jar" key={att.id}>
                <div className="jar-l">{att.label}</div>
                <div className="jar-s">
                  {[1, 2, 3, 4, 5].map((v) => (
                    <button key={v} data-on={draft.jar[att.id] === v ? "1" : "0"} data-mid={v === 3 ? "1" : "0"}
                      aria-pressed={draft.jar[att.id] === v}
                      onClick={() => set({ ...draft, jar: { ...draft.jar, [att.id]: draft.jar[att.id] === v ? undefined : v } })}>
                      {v === 1 ? att.lo : v === 3 ? "Right" : v === 5 ? att.hi : ""}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 5 — the call */}
      <div>
        <div className="qhead">
          <span className="qn">5</span>
          <span className="qt">Your call on line {tap.line}</span>
          <span className="qopt">{tap.brand}</span>
        </div>
        {hint && (
          <div className="verd" style={{ marginBottom: 10 }}>
            <div style={{
              fontFamily: "var(--gauge)", fontSize: 15, fontWeight: 600, minWidth: 26, paddingTop: 2,
              color: hint.level === "pull" ? "var(--pull)" : hint.level === "pass" ? "var(--pass)" : "var(--watch)",
            }}>§7</div>
            <div style={{ minWidth: 0 }}>
              <div className="verd-k">The limits say</div>
              <div className="verd-v" style={{
                color: hint.level === "pull" ? "var(--pull)" : hint.level === "pass" ? "var(--pass)" : "var(--watch)",
              }}>{hint.label}</div>
              <div className="verd-w">{hint.why}</div>
            </div>
          </div>
        )}
        <div className="opts opts-4">
          {ACTIONS.map((o) => (
            <button key={o.v} className="opt" data-on={draft.action === o.v ? "1" : "0"} data-t={o.tone}
              data-rec={hint && hint.suggest === o.v ? "1" : "0"} aria-pressed={draft.action === o.v}
              style={{ padding: "11px 8px" }} onClick={() => set({ ...draft, action: o.v })}>
              <b style={{ fontSize: 13 }}>{o.label}</b>
              <small>{o.hint}</small>
            </button>
          ))}
        </div>
      </div>

      <input placeholder="Note, if there is one" value={draft.note} onChange={(e) => set({ ...draft, note: e.target.value })} aria-label="Note" />

      <div className="row" style={{ gap: 8 }}>
        <button className="btn" data-ghost="1" onClick={onBack} disabled={idx === 0}>Back</button>
        <button className="btn" data-ghost="1" onClick={onSkip}>Skip</button>
        <button className="btn btn-lg" data-p="1" style={{ flex: 1 }} disabled={!ready} onClick={onSubmit}>
          {ready
            ? (idx + 1 === total ? `File ${brandShort} and finish` : `File ${brandShort}, pour the next`)
            : `Still need ${missing.join(", ")}`}
        </button>
      </div>

      {nextTap && (
        <div className="pour-next">
          Next: <b>line {String(nextTap.line).padStart(2, "0")} &middot; {nextTap.brand}</b>
        </div>
      )}
    </div>
    </div>
  );
}

function Session({ taps, tasters, a, settings, me, results, sessions, api, kind, clearKind, onExit, onPickMe, toast }) {
  const [plan, setPlan] = useState(null);
  const [planKind, setPlanKind] = useState(null);
  const [customIds, setCustom] = useState([]);
  const [idx, setIdx] = useState(0);
  const [draft, setDraft] = useState(emptyDraft());
  const [phase, setPhase] = useState("plan");
  const [savedIds, setSaved] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [resume, setResume] = useState(() => {
    const d = local.get(LS_DRAFT, null);
    return d && d.date === todayISO() && d.plan && d.plan.length
      ? { ...d, savedIds: d.savedIds || [], draft: d.draft || emptyDraft() }
      : null;
  });

  const start = useCallback((k, ids) => {
    const p = buildPlan(k, taps, a, ids || customIds, settings);
    if (!p.length) { toast("Nothing to taste in that flight"); return; }
    const sid = `${todayISO()}-${k.startsWith("one:") ? "spot" : k}`;
    setPlan(p); setPlanKind(k); setSessionId(sid); setIdx(0); setDraft(emptyDraft()); setSaved([]); setPhase("taste");
    api.saveSession({
      id: sid, date: todayISO(), flight: k, plan: p,
      startedAt: new Date().toISOString(),
      participants: { [me.id]: { name: me.name, at: new Date().toISOString() } },
    });
  }, [taps, a, customIds, settings, api, me, toast]);

  /* A start requested from the wall. */
  useEffect(() => {
    if (kind && me && phase === "plan" && !plan) { start(kind); clearKind(); }
  }, [kind, me, phase, plan, start, clearKind]);

  /* Keep the device copy warm so a locked phone or a reload does not cost
     the morning. */
  useEffect(() => {
    if (phase !== "taste" || !plan) return;
    local.set(LS_DRAFT, { date: todayISO(), sessionId, kind: planKind, plan, idx, draft, savedIds });
  }, [phase, plan, idx, draft, savedIds, sessionId, planKind]);

  if (!me) {
    return (
      <div className="stack" style={{ maxWidth: 560 }}>
        <Empty
          title="Who is tasting?"
          body="Pick your name once and this device will remember it. Everyone scores on their own phone, and the panel mean assembles itself."
          action={<button className="btn" data-p="1" onClick={onPickMe}>Choose your name</button>}
        />
      </div>
    );
  }

  /* ---------------------------------------------------------- the planner */
  if (phase === "plan" || !plan) {
    const today = todaysFlight();
    const live = sessions.filter((s) => s.date === todayISO());
    /* Naming the beers on the button. Nobody should have to start a flight
       to find out what is in it. */
    const preview = (k) => buildPlan(k, taps, a, customIds, settings);
    const lineup = (ids) => {
      const named = ids.map((id) => a.tapById[id]).filter(Boolean);
      const head = named.slice(0, 5).map((t) => `${String(t.line).padStart(2, "0")} ${t.brand}`).join("  \u00b7  ");
      return named.length > 5 ? `${head}  \u00b7  +${named.length - 5} more` : head;
    };

    return (
      <div className="stack" style={{ maxWidth: 720 }}>
        {resume && (
          <div className="sig" data-sev="info">
            <div className="sig-ic">&#8635;</div>
            <div style={{ minWidth: 0 }}>
              <div className="sig-t">You left a flight unfinished</div>
              <div className="sig-d">{resume.savedIds.length} of {resume.plan.length} scored. Pick it up where you stopped, or start fresh.</div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn btn-sm" data-p="1" onClick={() => {
                  setPlan(resume.plan); setPlanKind(resume.kind); setSessionId(resume.sessionId);
                  setIdx(resume.idx); setDraft(resume.draft || emptyDraft()); setSaved(resume.savedIds || []);
                  setPhase("taste"); setResume(null);
                }}>Resume</button>
                <button className="btn btn-sm" data-ghost="1" onClick={() => { local.del(LS_DRAFT); setResume(null); }}>Discard</button>
              </div>
            </div>
          </div>
        )}

        {live.length > 0 && (
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 8 }}>Already running today</div>
            {live.map((s) => {
              const names = Object.values(s.participants || {}).map((p) => p.name).join(", ");
              return (
                <div className="row" key={s.id} style={{ justifyContent: "space-between", padding: "6px 0" }}>
                  <div>
                    <b style={{ fontSize: 13.5 }}>{FLIGHTS.find((f) => f.id === s.flight) ? FLIGHTS.find((f) => f.id === s.flight).label : s.flight}</b>
                    <div className="dim" style={{ fontSize: 12 }}>{s.plan.length} samples · {names || "nobody yet"}</div>
                  </div>
                  <button className="btn btn-sm" onClick={() => {
                    setPlan(s.plan); setPlanKind(s.flight); setSessionId(s.id);
                    setIdx(0); setDraft(emptyDraft()); setSaved([]); setPhase("taste");
                    api.saveSession({ ...s, participants: { ...(s.participants || {}), [me.id]: { name: me.name, at: new Date().toISOString() } } });
                  }}>Join</button>
                </div>
              );
            })}
          </div>
        )}

        <div className="h">Build the flight</div>
        <div className="stack" style={{ gap: 10 }}>
          {FLIGHTS.map((f) => {
            const ids = preview(f.id);
            const isToday = today && today.id === f.id;
            return (
              <button key={f.id} className="card" style={{ borderColor: isToday ? "var(--shank2)" : undefined }} onClick={() => start(f.id)} disabled={!ids.length}>
                <div className="row">
                  <b style={{ fontSize: 15 }}>{f.label}</b>
                  <span className="chip">{f.dayLabel}</span>
                  {isToday && <span className="chip" data-t="solid">today</span>}
                  <span className="lc-mono dim" style={{ marginLeft: "auto", fontSize: 12 }}>{ids.length} samples</span>
                </div>
                {ids.length > 0 && <div className="lineup">{lineup(ids)}</div>}
                <div className="mut" style={{ fontSize: 12.5, marginTop: 6 }}>{f.note}</div>
              </button>
            );
          })}
          <button className="card" onClick={() => start("due")} disabled={!preview("due").length}>
            <div className="row">
              <b style={{ fontSize: 15 }}>Everything overdue</b>
              <span className="lc-mono dim" style={{ marginLeft: "auto", fontSize: 12 }}>{preview("due").length} samples</span>
            </div>
            {preview("due").length > 0 && <div className="lineup">{lineup(preview("due"))}</div>}
            <div className="mut" style={{ fontSize: 12.5, marginTop: 6 }}>
              Anything outside the {settings.coverageDays} day window, plus anything flagged, in palate order.
            </div>
          </button>
        </div>

        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 9 }}>Or pick them yourself</div>
          <div className="fchips">
            {taps.filter((t) => t.active && !t.onDeck).sort((x, y) => x.line - y.line).map((t) => (
              <button key={t.id} className="fchip" data-on={customIds.includes(t.id) ? "1" : "0"}
                aria-pressed={customIds.includes(t.id)}
                onClick={() => setCustom(customIds.includes(t.id) ? customIds.filter((x) => x !== t.id) : [...customIds, t.id])}>
                <span className="lc-mono dim" style={{ marginRight: 6 }}>{String(t.line).padStart(2, "0")}</span>{t.brand}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" data-p="1" disabled={!customIds.length} onClick={() => start("custom")}>
              Build a {customIds.length}-sample flight
            </button>
            {customIds.length > 0 && <button className="btn" data-ghost="1" onClick={() => setCustom([])}>Clear</button>}
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------- finished */
  const savedRows = results.filter((r) => savedIds.includes(r.id));
  if (phase === "done") {
    const byTap = {};
    for (const id of plan) {
      const rows = results.filter((r) => r.tapId === id && r.date === todayISO());
      if (rows.length) byTap[id] = rows;
    }
    const summary = sessionSummaryText(savedRows, taps, tasters, settings, a);
    return (
      <div className="stack" style={{ maxWidth: 720 }}>
        <div>
          <div className="eyebrow">Session closed</div>
          <h2 style={{ fontFamily: "var(--gauge)", fontSize: 32, fontWeight: 600, letterSpacing: "-0.025em", margin: "6px 0 4px", color: "var(--foam)" }}>
            {savedIds.length} {savedIds.length === 1 ? "score" : "scores"} filed
          </h2>
          <p className="lede">Everything below was written as you went. Nothing is waiting to be saved.</p>
        </div>

        <div className="wall">
          {Object.entries(byTap).map(([tapId, rows]) => {
            const t = a.tapById[tapId];
            const m = mean(rows.map((r) => r.liking).filter(num));
            const worst = rows.flatMap((r) => r.faults || []).reduce((x, f) => (x === null || f.i > x.i ? f : x), null);
            const pull = rows.some((r) => r.action && r.action.startsWith("pull"));
            const watch = rows.some((r) => r.action === "watch");
            return (
              <div className="wrow" key={tapId} data-s={pull ? "pull" : watch ? "watch" : "pass"} style={{ cursor: "default" }}>
                <div className="wrow-n">{String(t ? t.line : "?").padStart(2, "0")}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="wrow-name">{t ? t.brand : "Unknown"}</div>
                  <div className="wrow-sub">
                    <span>{rows.length} {rows.length === 1 ? "taster" : "tasters"}</span>
                    {worst && <span className="chip" data-t={worst.i >= settings.faultPull ? "pull" : "watch"}>
                      {FAULT_BY_ID[worst.id] ? FAULT_BY_ID[worst.id].label.split(" /")[0] : worst.id} {worst.i}
                    </span>}
                    {pull && <span className="chip" data-t="pull">pull</span>}
                  </div>
                </div>
                <div className="wrow-trace" />
                <div className="wrow-score" style={{ color: pull ? "var(--pull)" : watch ? "var(--watch)" : "var(--pass)" }}>
                  {m === null ? "\u2014" : m.toFixed(1)}
                </div>
                <div className="wrow-fresh" />
              </div>
            );
          })}
        </div>

        <div className="row">
          <button className="btn" data-p="1" onClick={() => { local.del(LS_DRAFT); onExit(); }}>Back to the wall</button>
          <button className="btn" onClick={async () => {
            const ok = await copyText(summary);
            toast(ok ? "Summary copied" : "Copy blocked by the browser");
          }}>Copy summary</button>
          <button className="btn" data-ghost="1" onClick={() => { setPlan(null); setPhase("plan"); setSaved([]); local.del(LS_DRAFT); }}>
            Taste something else
          </button>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------- the tasting */
  const tapId = plan[idx];
  const tap = a.tapById[tapId];
  const stat = a.statsById[tapId];
  if (!tap) {
    return (
      <div className="stack" style={{ maxWidth: 560 }}>
        <Empty title="That tap is gone" body="It was removed from the wall while this flight was open." 
          action={<button className="btn" data-p="1" onClick={() => setPhase("done")}>Close the session</button>} />
      </div>
    );
  }
  const peers = results.filter((r) => r.tapId === tapId && r.date === todayISO() && r.tasterId !== me.id);
  const advance = () => {
    setDraft(emptyDraft());
    if (idx + 1 < plan.length) setIdx(idx + 1);
    else setPhase("done");
  };

  const submit = async () => {
    const hint = verdictFor({
      check: {
        mean: draft.liking, n: 1, rows: [draft],
        ttbNo: draft.ttb === "no" ? 1 : 0, faults: draft.faults,
        worstFault: draft.faults.reduce((m, f) => (m === null || f.i > m.i ? f : m), null),
      },
      tap, settings, prevCheck: stat ? stat.last : null, fresh: stat ? stat.fresh : null,
    });
    const row = {
      id: uid(),
      sessionId: sessionId || `${todayISO()}-adhoc`,
      date: todayISO(),
      tapId: tap.id,
      tasterId: me.id,
      line: tap.line,
      pkg: tap.pkg || "",
      dlScore: tap.dlScore || "",
      ageDays: daysSince(tap.pkg),
      ttb: draft.ttb,
      missWhere: draft.missWhere,
      liking: draft.liking,
      faults: draft.faults,
      jar: Object.keys(draft.jar || {}).length ? draft.jar : null,
      action: draft.action,
      recommended: hint.level,
      note: draft.note,
      at: new Date().toISOString(),
    };
    await api.saveResult(row);
    if (tap.flag) api.saveTap({ ...tap, flag: null });
    setSaved((prev) => [...prev, row.id]);
    advance();
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="row" style={{ marginBottom: 12, gap: 10 }}>
        <button className="btn btn-sm" data-ghost="1" onClick={() => {
          if (savedIds.length) setPhase("done"); else { setPlan(null); setPhase("plan"); }
        }}>&larr; Leave</button>
        <span className="lc-mono dim" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.12em", marginLeft: "auto" }}>
          {savedIds.length} filed
        </span>
      </div>
      <div className="rail" aria-label={`Sample ${idx + 1} of ${plan.length}`}>
        {plan.map((id, i) => {
          const t = a.tapById[id];
          return (
            <i key={i} data-on={i < idx ? "done" : i === idx ? "now" : "next"}
              title={t ? `${i + 1}. line ${t.line} \u00b7 ${t.brand}` : `Sample ${i + 1}`} />
          );
        })}
      </div>
      <TasteCard
        key={tapId}
        tap={tap} stat={stat} taster={me} draft={draft} set={setDraft} settings={settings}
        idx={idx} total={plan.length} nextTap={a.tapById[plan[idx + 1]] || null}
        peers={peers} tasters={tasters}
        onSubmit={submit}
        onBack={() => { setDraft(emptyDraft()); setIdx(Math.max(0, idx - 1)); }}
        onSkip={advance}
      />
    </div>
  );
}

/* ==========================================================================
   TAPS
   ========================================================================== */

function useDebouncedSave(fn, ms = 700) {
  const timers = useRef({});
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  return useCallback((key, payload, done) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(async () => {
      await fn(payload);
      if (done) done();
    }, ms);
  }, [fn, ms]);
}

/* Accepts tab, pipe, comma, or "12 Brand Name" and works out the rest. */
function parseTapPaste(text, settings) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || /^(line|tap)\b/i.test(s)) continue;
    let parts;
    if (s.includes("\t")) parts = s.split("\t");
    else if (s.includes("|")) parts = s.split("|");
    else if (s.includes(",")) parts = s.split(",");
    else {
      const m = s.match(/^(\d{1,3})[).:\s]+(.*)$/);
      parts = m ? [m[1], m[2]] : [null, s];
    }
    parts = parts.map((p) => (p === null ? "" : String(p).trim()));
    let line = parseInt(parts[0], 10);
    let rest = parts.slice(1);
    if (Number.isNaN(line)) { line = 0; rest = parts; }
    const brand = rest[0] || "";
    if (!brand) continue;

    let style = "";
    let pkg = "";
    let dl = "";
    for (const f of rest.slice(1)) {
      if (!f) continue;
      const hitStyle = STYLE_ORDER.find((st) => st.toLowerCase() === f.toLowerCase())
        || STYLE_ORDER.find((st) => f.toLowerCase().includes(st.toLowerCase().split(" ")[0]));
      const iso = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const us = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      const n = parseFloat(f);
      if (!style && hitStyle) style = hitStyle;
      else if (!pkg && iso) pkg = f;
      else if (!pkg && us) {
        const y = us[3].length === 2 ? `20${us[3]}` : us[3];
        pkg = `${y}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
      } else if (!dl && !Number.isNaN(n) && n >= 1 && n <= 9) dl = String(n);
    }
    out.push({
      id: uid(), line: line || 0, brand,
      style: style || "Light & Crisp",
      pkg, dlScore: dl, shelf: null, active: true, onDeck: false, notes: "", flag: null,
    });
  }
  return out;
}

function Taps({ taps, settings, api, toast }) {
  const [draftMap, setDraftMap] = useState({});
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const save = useDebouncedSave(api.saveTap);

  const view = taps.map((t) => ({ ...t, ...(draftMap[t.id] || {}) }));
  const release = (id) => setDraftMap((m) => {
    const n = { ...m };
    delete n[id];
    return n;
  });
  const edit = (t, patch) => {
    const next = { ...t, ...patch };
    setDraftMap((m) => ({ ...m, [t.id]: { ...(m[t.id] || {}), ...patch } }));
    save(t.id, next, () => release(t.id));
  };
  const add = () => {
    const maxLine = Math.max(0, ...taps.map((t) => t.line || 0));
    const t = {
      id: uid(), line: maxLine + 1, brand: "", style: "Light & Crisp", pkg: "",
      dlScore: "", shelf: null, active: true, onDeck: false, notes: "", flag: null,
    };
    api.saveTap(t);
  };

  const parsed = useMemo(() => (paste.trim() ? parseTapPaste(paste, settings) : []), [paste, settings]);
  const applyPaste = async () => {
    const byLine = Object.fromEntries(taps.map((t) => [t.line, t]));
    const merged = parsed.map((p) => {
      const hit = byLine[p.line];
      return hit ? { ...hit, brand: p.brand, style: p.style, pkg: p.pkg || hit.pkg, dlScore: p.dlScore || hit.dlScore, active: true } : p;
    });
    await api.saveTaps(merged);
    setPaste(""); setShowPaste(false);
    toast(`${merged.length} taps written`);
  };

  const table = (list, title, note) => (
    <div className="sec">
      <div className="h">{title} <span className="lc-mono" style={{ color: "var(--faint)" }}>{list.length}</span></div>
      {note && <p className="lede">{note}</p>}
      {list.length === 0 ? (
        <Empty title="Nothing here yet" body={title === "On deck" ? "Kegs you move here stay out of the rotation until you put them on the wall." : "Add a tap, or paste your whole list at once."} action={null} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 58 }}>Line</th><th style={{ minWidth: 170 }}>Brand</th>
                <th style={{ width: 132 }}>Style</th><th style={{ width: 142 }}>Packaged</th>
                <th style={{ width: 82 }}>Code</th><th style={{ width: 78 }}>Release</th>
                <th style={{ width: 118 }}>Where</th><th style={{ width: 36 }} />
              </tr>
            </thead>
            <tbody>
              {list.slice().sort((x, y) => x.line - y.line).map((t) => (
                <tr key={t.id} data-off={t.active ? "0" : "1"}>
                  <td><input className="lc-mono" type="number" value={t.line} aria-label="Line number"
                    onChange={(e) => edit(t, { line: Number(e.target.value) })} /></td>
                  <td><input value={t.brand} placeholder="Brand" aria-label="Brand"
                    onChange={(e) => edit(t, { brand: e.target.value })} /></td>
                  <td><select value={t.style} aria-label="Style" onChange={(e) => edit(t, { style: e.target.value })}>
                    {STYLE_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select></td>
                  <td><input type="date" value={t.pkg || ""} aria-label="Package date"
                    onChange={(e) => edit(t, { pkg: e.target.value })} /></td>
                  <td><input className="lc-mono" type="number" value={t.shelf || ""} aria-label="Shelf life in days"
                    placeholder={String(shelfFor(t, settings))} onChange={(e) => edit(t, { shelf: e.target.value ? Number(e.target.value) : null })} /></td>
                  <td><input className="lc-mono" value={t.dlScore || ""} placeholder="7.8" aria-label="DraughtLab release score"
                    onChange={(e) => edit(t, { dlScore: e.target.value })} /></td>
                  <td>
                    <select aria-label="Placement" value={t.onDeck ? "deck" : t.active ? "wall" : "off"}
                      onChange={(e) => {
                        const v = e.target.value;
                        edit(t, { active: v !== "off", onDeck: v === "deck" });
                      }}>
                      <option value="wall">On the wall</option>
                      <option value="deck">On deck</option>
                      <option value="off">Retired</option>
                    </select>
                  </td>
                  <td>
                    <button className="btn btn-sm" data-ghost="1" aria-label={`Delete ${t.brand}`}
                      onClick={() => {
                        if (window.confirm(`Delete line ${t.line} ${t.brand}? Scores already filed against it stay in the record.`)) api.deleteTap(t.id);
                      }}>&times;</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="h">
        Taps
        <button className="btn btn-sm" onClick={() => setShowPaste(!showPaste)}>Paste a list</button>
        <button className="btn btn-sm" data-p="1" onClick={add}>Add a tap</button>
      </div>
      <p className="lede">
        Changing a package date starts a new keg: the wall stats reset and the old scores stay in the record, still feeding the
        freshness curve. Leave the code column empty to use the house default of {settings.defaultShelfDays} days.
      </p>

      {showPaste && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>One tap per line</div>
          <textarea rows={7} value={paste} onChange={(e) => setPaste(e.target.value)}
            placeholder={"1 | Zip's Pilz | Light & Crisp | 2026-07-28 | 7.8\n2 | PsycHOPathy | Hoppy | 2026-08-02 | 7.6\n14  Old Stick"} />
          <div className="row" style={{ marginTop: 10 }}>
            <span className="dim" style={{ fontSize: 12.5 }}>
              {parsed.length ? `${parsed.length} taps read. Lines that already exist will be updated, not duplicated.` : "Tab, pipe, comma, or just a number and a name."}
            </span>
            <button className="btn" data-p="1" style={{ marginLeft: "auto" }} disabled={!parsed.length} onClick={applyPaste}>
              Write {parsed.length || ""} taps
            </button>
          </div>
        </div>
      )}

      {table(view.filter((t) => !t.onDeck && t.active), "On the wall", null)}
      {table(view.filter((t) => t.onDeck), "On deck", "Staged for the changeover. These stay out of the rotation and off the coverage count.")}
      {view.some((t) => !t.active && !t.onDeck) && table(view.filter((t) => !t.active && !t.onDeck), "Retired", null)}
    </div>
  );
}

/* ==========================================================================
   PANEL
   ========================================================================== */

function Panel({ tasters, a, api, me, onPickMe, toast }) {
  const [draftMap, setDraftMap] = useState({});
  const save = useDebouncedSave(api.saveTaster);
  const view = tasters.map((t) => ({ ...t, ...(draftMap[t.id] || {}) }));
  const edit = (t, patch) => {
    setDraftMap((m) => ({ ...m, [t.id]: { ...(m[t.id] || {}), ...patch } }));
    save(t.id, { ...t, ...patch }, () => setDraftMap((m) => {
      const n = { ...m };
      delete n[t.id];
      return n;
    }));
  };
  const statOf = (id) => a.tasterStats.find((s) => s.tasterId === id);

  return (
    <div>
      <div className="h">
        Panel
        <button className="btn btn-sm" data-p="1" onClick={() => api.saveTaster({ id: uid(), name: "", title: "", active: true, trainee: false })}>
          Add a panelist
        </button>
      </div>
      <p className="lede">
        Everyone tastes on their own phone. Mark someone a trainee while they are scoring alongside — their numbers are still
        recorded and still shown here, they just do not count toward a pass or a pull.
      </p>

      <div className="row" style={{ marginBottom: 18 }}>
        <span className="eyebrow">This device is</span>
        <button className="btn btn-sm" onClick={onPickMe}>{me ? `${me.name} · ${me.title || "panelist"}` : "Nobody yet"}</button>
      </div>

      {view.length === 0 ? (
        <Empty title="No panelists yet" body="Add yourself first, then everyone else who will be tasting." action={null} />
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ minWidth: 150 }}>Name</th><th style={{ minWidth: 130 }}>Title</th>
                <th style={{ width: 116 }}>Standing</th><th style={{ width: 62 }}>Scores</th>
                <th style={{ width: 70 }}>Mean</th><th style={{ width: 96 }}>Bias</th>
                <th style={{ width: 96 }}>Reads faults</th><th style={{ width: 36 }} />
              </tr>
            </thead>
            <tbody>
              {view.map((t) => {
                const s = statOf(t.id);
                return (
                  <tr key={t.id} data-off={t.active ? "0" : "1"}>
                    <td><input value={t.name} placeholder="Name" aria-label="Name" onChange={(e) => edit(t, { name: e.target.value })} /></td>
                    <td><input value={t.title} placeholder="Cellarman" aria-label="Title" onChange={(e) => edit(t, { title: e.target.value })} /></td>
                    <td>
                      <select aria-label="Standing" value={!t.active ? "off" : t.trainee ? "trainee" : "full"}
                        onChange={(e) => {
                          const v = e.target.value;
                          edit(t, { active: v !== "off", trainee: v === "trainee" });
                        }}>
                        <option value="full">Counts</option>
                        <option value="trainee">Trainee</option>
                        <option value="off">Inactive</option>
                      </select>
                    </td>
                    <td className="n dim">{s ? s.n : 0}</td>
                    <td className="n">{s && s.mean !== null ? s.mean.toFixed(2) : "\u2014"}</td>
                    <td className="n">
                      {s && s.bias !== null ? (
                        <span style={{ color: s.severity === "aligned" ? "var(--head)" : s.severity === "severe" ? "var(--info)" : "var(--watch)" }}>
                          {s.bias > 0 ? "+" : ""}{s.bias.toFixed(2)}
                          <span className="dim" style={{ fontSize: 10 }}> {s.severity}</span>
                        </span>
                      ) : <span className="dim">&mdash;</span>}
                    </td>
                    <td className="n dim">{s && s.faultRate !== null ? `${Math.round(s.faultRate * 100)}%` : "\u2014"}</td>
                    <td>
                      <button className="btn btn-sm" data-ghost="1" aria-label={`Remove ${t.name}`}
                        onClick={() => {
                          if (window.confirm(`Remove ${t.name || "this panelist"}? Their scores stay in the record.`)) api.deleteTaster(t.id);
                        }}>&times;</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="lede" style={{ marginTop: 16 }}>
        Bias is a panelist's average distance from everyone else on the same beer on the same day. It is a description, not a
        grade. A severe palate is useful as long as everyone knows it is severe — it just means two people's raw numbers are not
        interchangeable. Judge trends within a panelist and use the panel mean for a pass or a pull.
      </p>
    </div>
  );
}

/* ==========================================================================
   DATA
   ========================================================================== */

function Data({ a, results, taps, tasters, settings, api, archive, toast }) {
  /* archive !== null means the whole record is loaded and feeding everything
     on this page. */
  const [loading, setLoading] = useState(false);
  const [openSettings, setOpenSettings] = useState(false);
  const [recentQ, setRecentQ] = useState("");
  const [showAllDays, setShowAllDays] = useState(false);
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);

  const nameOf = (id) => {
    const t = tasters.find((x) => x.id === id);
    return t ? `${t.name}${t.title ? ` (${t.title})` : ""}` : id;
  };

  const exportCsv = (rows, label) => {
    const head = [
      "date", "session", "line", "brand", "style", "package_date", "days_since_package",
      "dl_release_score", "taster", "taster_title", "true_to_brand", "misses",
      "liking", "faults", "fault_origins", "max_fault_intensity",
      "call", "limits_said", "note",
    ];
    const out = [head.join(",")];
    for (const r of rows.slice().sort((x, y) => x.date.localeCompare(y.date))) {
      const t = a.tapById[r.tapId] || {};
      const ta = tasters.find((x) => x.id === r.tasterId) || {};
      const fs = r.faults || [];
      out.push([
        r.date, r.sessionId, t.line, t.brand, t.style, r.pkg, r.ageDays, r.dlScore,
        ta.name || r.tasterId, ta.title || "",
        r.ttb, (r.missWhere || []).join("|"), r.liking,
        fs.map((f) => `${FAULT_BY_ID[f.id] ? FAULT_BY_ID[f.id].label : f.id}:${f.i}`).join("|"),
        fs.map((f) => (FAULT_BY_ID[f.id] ? ORIGIN_LABEL[FAULT_BY_ID[f.id].origin] : "")).join("|"),
        fs.length ? Math.max(...fs.map((f) => f.i)) : "",
        r.action, r.recommended, r.note,
      ].map(csvCell).join(","));
    }
    download(`linecheck_${label}_${todayISO()}.csv`, out.join("\n"));
    toast(`${rows.length} rows exported`);
  };

  const curves = a.brandCurves.filter((c) => c.n >= 4);
  const maxWeight = a.pareto.length ? a.pareto[0].weight : 1;

  /* Everything filed, newest first, grouped by the day it was tasted. A
     mis-scored sample, or a whole afternoon of trying the app out, has to be
     removable or it sits in the mean forever. */
  const days = useMemo(() => {
    const q = recentQ.trim().toLowerCase();
    const map = {};
    for (const r of results) {
      const t = a.tapById[r.tapId];
      if (q) {
        const hay = `${t ? t.brand : ""} ${t ? t.line : ""} ${nameOf(r.tasterId)} ${r.date}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      (map[r.date] ||= []).push(r);
    }
    return Object.entries(map)
      .sort((x, y) => y[0].localeCompare(x[0]))
      .map(([date, rows]) => ({
        date,
        rows: rows.slice().sort((x, y) => (x.at || "").localeCompare(y.at || "")),
      }));
  }, [results, recentQ, a.tapById, tasters]);

  const shownDays = showAllDays ? days : days.slice(0, 3);

  const removeOne = async (r) => {
    const t = a.tapById[r.tapId];
    const what = `${t ? `line ${t.line} ${t.brand}` : "this sample"} at ${r.liking}, ${fmtDate(r.date)}`;
    if (!window.confirm(`Delete ${what}? It comes out of every mean, curve and signal straight away.`)) return;
    await api.deleteResult(r.id);
    toast("Score deleted");
  };

  const removeDay = async (day) => {
    if (!window.confirm(`Delete all ${day.rows.length} ${day.rows.length === 1 ? "score" : "scores"} from ${fmtDate(day.date)}? This cannot be undone.`)) return;
    for (const r of day.rows) await api.deleteResult(r.id);
    toast(`${day.rows.length} deleted`);
  };

  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="h">
        Data
        <button className="btn btn-sm" onClick={() => exportCsv(results, archive ? "all" : "recent")}>Export CSV</button>
        {archive ? (
          <span className="chip" data-t="pass">full record loaded</span>
        ) : (
          <button className="btn btn-sm" data-ghost="1" disabled={loading} onClick={async () => {
            setLoading(true);
            const all = await api.loadArchive();
            setLoading(false);
            toast(all ? `${all.length} scores loaded` : "Could not reach the archive");
          }}>{loading ? "Loading\u2026" : "Load full history"}</button>
        )}
      </div>
      <p className="lede">
        Day to day this page works off the last 210 days, which keeps the app quick. Load the full record and every curve,
        report and export below widens to the whole archive. Minimum retention is 24 months, which is what a real shelf-life
        analysis needs.
      </p>

      {/* ---- the record ---- */}
      <div className="sec">
        <div className="h">
          Every score filed
          <span className="lc-mono dim" style={{ fontSize: 10.5, marginLeft: "auto" }}>{results.length} rows</span>
        </div>
        <p className="lede">
          The raw record, newest first. Delete anything that should not be in the numbers &mdash; a mis-tap, a practice run,
          a sample scored on the wrong line. It leaves every mean, curve and signal the moment it goes.
        </p>
        {results.length === 0 ? (
          <Empty title="Nothing filed yet" body="Scores show up here the moment anyone submits one, from any phone." action={null} />
        ) : (
          <>
            <input
              value={recentQ} onChange={(e) => setRecentQ(e.target.value)}
              placeholder="Find a brand, taster, line, or date"
              style={{ maxWidth: 300, marginBottom: 12 }} aria-label="Search filed scores"
            />
            {days.length === 0 ? (
              <div className="dim" style={{ fontSize: 13 }}>Nothing matches that.</div>
            ) : (
              <div className="stack" style={{ gap: 14 }}>
                {shownDays.map((day) => (
                  <div key={day.date}>
                    <div className="row" style={{ marginBottom: 6 }}>
                      <span className="eyebrow">{fmtDate(day.date)} &middot; {day.rows.length} {day.rows.length === 1 ? "score" : "scores"}</span>
                      <button className="btn btn-sm" data-ghost="1" data-danger="1" style={{ marginLeft: "auto" }}
                        onClick={() => removeDay(day)}>Delete the day</button>
                    </div>
                    <div className="wall">
                      {day.rows.map((r) => {
                        const t = a.tapById[r.tapId];
                        const worst = (r.faults || []).reduce((m, f) => (m === null || f.i > m.i ? f : m), null);
                        return (
                          <div className="rrow" key={r.id}>
                            <div className="rrow-n">{t ? String(t.line).padStart(2, "0") : "??"}</div>
                            <div style={{ minWidth: 0 }}>
                              <div className="rrow-name">{t ? t.brand : "Deleted tap"}</div>
                              <div className="rrow-sub">
                                <span>{nameOf(r.tasterId)}</span>
                                {r.ttb === "no" && <span style={{ color: "var(--pull)" }}>not true to brand</span>}
                                {r.ttb === "marginal" && <span style={{ color: "var(--watch)" }}>marginal</span>}
                                {worst && (
                                  <span className="chip" data-t={worst.i >= settings.faultPull ? "pull" : worst.i >= settings.faultInvestigate ? "watch" : ""}>
                                    {FAULT_BY_ID[worst.id] ? FAULT_BY_ID[worst.id].label.split(" /")[0] : worst.id} {worst.i}
                                  </span>
                                )}
                                {r.note && <span style={{ fontStyle: "italic" }}>&ldquo;{r.note}&rdquo;</span>}
                              </div>
                            </div>
                            <div className="rrow-score" style={{
                              color: !num(r.liking) ? "var(--dim)"
                                : r.liking < settings.likingWatch ? "var(--pull)"
                                : r.liking < settings.likingPass ? "var(--watch)" : "var(--pass)",
                            }}>{num(r.liking) ? r.liking : "\u2014"}</div>
                            <button className="rrow-x" onClick={() => removeOne(r)}
                              aria-label={`Delete ${t ? t.brand : "this"} score by ${nameOf(r.tasterId)}`}>&times;</button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {days.length > shownDays.length && (
                  <button className="btn btn-sm" data-ghost="1" onClick={() => setShowAllDays(true)}>
                    Show the other {days.length - shownDays.length} {days.length - shownDays.length === 1 ? "day" : "days"}
                  </button>
                )}
                {showAllDays && days.length > 3 && (
                  <button className="btn btn-sm" data-ghost="1" onClick={() => setShowAllDays(false)}>Show recent days only</button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ---- freshness ---- */}
      <div className="sec">
        <div className="h">How each brand ages on tap</div>
        <p className="lede">
          Liking against days since package, pooled across every keg. The dashed gold line is your action limit and the dotted
          grey line is the release score. Where the fit crosses the limit is where that brand actually falls out of code, which
          is a better number than the one on the sell sheet.
        </p>
        {curves.length === 0 ? (
          <Empty title="Not enough spread yet" body="A curve needs four scored samples at different keg ages. Keep the rotation running and these fill in on their own." action={null} />
        ) : (
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))" }}>
            {curves.map((c) => (
              <div className="card" key={c.brand}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <b style={{ fontSize: 14 }}>{c.brand}</b>
                  <span className="chip" style={{ marginLeft: "auto" }}>n={c.n}</span>
                </div>
                <Scatter curve={c} settings={settings} />
                <div style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>
                  {c.fit ? (
                    <>
                      {c.fit.slope < 0 ? "Losing " : "Gaining "}
                      <b className="lc-mono">{Math.abs(c.fit.slope * 30).toFixed(2)}</b> points a month.{" "}
                      {c.crossDays
                        ? <>Crosses {settings.likingPass} around <b className="lc-mono" style={{ color: "var(--watch)" }}>day {c.crossDays}</b>.</>
                        : <span className="dim">Holding up across the ages you have tasted.</span>}
                    </>
                  ) : <span className="dim">Needs samples at more than one age before a line means anything.</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- lines ---- */}
      <div className="sec">
        <div className="h">Line report card</div>
        <p className="lede">
          Every line measured against the rest of the wall rather than against an average that includes itself. A line that sits
          low across several different brands is hardware, not beer. A line that sits low on one brand is confounded until you
          draw at the coupler and at the faucet. Lines with fewer than five scores sit at the bottom: they cannot carry a read yet.
        </p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Line</th><th>Scores</th><th>Brands</th><th>Mean</th><th>vs rest of wall</th><th>Line-side faults</th><th>Read</th></tr>
            </thead>
            <tbody>
              {a.lineStats.map((l) => (
                <tr key={l.line}>
                  <td className="n">{String(l.line).padStart(2, "0")}</td>
                  <td className="n dim">{l.n}</td>
                  <td className="n dim">{l.brands}</td>
                  <td className="n">{l.mean === null ? "\u2014" : l.mean.toFixed(2)}</td>
                  <td className="n" style={{
                    color: l.delta === null ? "var(--dim)" : l.delta <= -0.5 ? "var(--pull)" : l.delta <= -0.2 ? "var(--watch)" : "var(--pass)",
                  }}>{l.delta === null ? "\u2014" : (l.delta > 0 ? "+" : "") + l.delta.toFixed(2)}</td>
                  <td className="n dim">{l.lineFaults || "\u2014"}</td>
                  <td style={{ fontSize: 12 }}>
                    {l.suspect ? <span className="chip" data-t="line">clean this line</span>
                      : l.confounded ? <span className="chip" data-t="info">confounded</span>
                      : l.n < 5 ? <span className="dim">need more data</span>
                      : <span className="dim">normal</span>}
                  </td>
                </tr>
              ))}
              {a.lineStats.length === 0 && <tr><td colSpan={7} className="dim">No scores filed yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- faults ---- */}
      <div className="sec">
        <div className="h">What goes wrong, in order</div>
        <p className="lede">Ranked by total intensity rather than raw count: one sample at 5 matters more than three at 1.</p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th style={{ minWidth: 190 }}>Fault</th><th style={{ width: 74 }}>Origin</th><th>Weight</th><th>Hits</th><th>Taps</th><th>Lines</th><th>Avg</th><th>Worst</th></tr></thead>
            <tbody>
              {a.pareto.map((f) => (
                <tr key={f.id}>
                  <td>{f.def ? f.def.label : f.id}</td>
                  <td><span className="chip" data-t={f.def && f.def.origin === "L" ? "line" : f.def && f.def.origin === "B" ? "watch" : "info"}>
                    {f.def ? ORIGIN_LABEL[f.def.origin] : "?"}
                  </span></td>
                  <td style={{ minWidth: 90 }}>
                    <div className="bar-mini"><i style={{ width: `${(f.weight / maxWeight) * 100}%` }} /></div>
                  </td>
                  <td className="n dim">{f.n}</td>
                  <td className="n dim">{f.taps}</td>
                  <td className="n dim">{f.lines}</td>
                  <td className="n" style={{ color: f.avgI >= settings.faultPull ? "var(--pull)" : f.avgI >= settings.faultInvestigate ? "var(--watch)" : "inherit" }}>{f.avgI.toFixed(1)}</td>
                  <td className="n dim">{f.maxI}</td>
                </tr>
              ))}
              {a.pareto.length === 0 && <tr><td colSpan={8} className="dim">Nothing logged. Either the wall is immaculate or nobody is checking the boxes.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- settings ---- */}
      <div className="sec">
        <div className="h">
          Limits
          <button className="btn btn-sm" data-ghost="1" onClick={() => setOpenSettings(!openSettings)}>{openSettings ? "Close" : "Edit"}</button>
        </div>
        {!openSettings ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="chip">pass at {settings.likingPass}</span>
            <span className="chip">watch under {settings.likingPass}</span>
            <span className="chip">investigate under {settings.likingWatch}</span>
            <span className="chip">fault {settings.faultInvestigate} investigate</span>
            <span className="chip">fault {settings.faultPull} pull</span>
            <span className="chip">{settings.coverageDays}d coverage</span>
            <span className="chip">{settings.defaultShelfDays}d house code</span>
            <span className="chip">drift alert {settings.driftAlert}</span>
          </div>
        ) : (
          <div className="card">
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12 }}>
              {[
                ["likingPass", "Pass at or above", 0.1],
                ["likingWatch", "Investigate below", 0.1],
                ["faultInvestigate", "Fault: investigate at", 1],
                ["faultPull", "Fault: pull at", 1],
                ["coverageDays", "Coverage window, days", 1],
                ["defaultShelfDays", "House code, days", 1],
                ["driftAlert", "Drift alert, points", 0.1],
                ["signalWindow", "Signal window, days", 1],
              ].map(([k, label, step]) => (
                <label key={k} style={{ display: "block" }}>
                  <div className="eyebrow" style={{ marginBottom: 5 }}>{label}</div>
                  <input className="lc-mono" type="number" step={step} value={s[k]}
                    onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
            <div className="hr" />
            <div className="eyebrow" style={{ marginBottom: 8 }}>Brands that carry a longer code</div>
            <div className="stack" style={{ gap: 8 }}>
              {(s.shelfOverrides || []).map((o, i) => (
                <div className="row" key={i} style={{ gap: 8 }}>
                  <input value={o.match} placeholder="Brand contains" aria-label="Brand match"
                    onChange={(e) => setS({ ...s, shelfOverrides: s.shelfOverrides.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)) })}
                    style={{ maxWidth: 220 }} />
                  <input className="lc-mono" type="number" value={o.days} aria-label="Days"
                    onChange={(e) => setS({ ...s, shelfOverrides: s.shelfOverrides.map((x, j) => (j === i ? { ...x, days: Number(e.target.value) } : x)) })}
                    style={{ maxWidth: 90 }} />
                  <button className="btn btn-sm" data-ghost="1" aria-label="Remove"
                    onClick={() => setS({ ...s, shelfOverrides: s.shelfOverrides.filter((_, j) => j !== i) })}>&times;</button>
                </div>
              ))}
              <button className="btn btn-sm" style={{ alignSelf: "flex-start" }}
                onClick={() => setS({ ...s, shelfOverrides: [...(s.shelfOverrides || []), { match: "", days: 180 }] })}>
                Add an exception
              </button>
            </div>
            <div className="hr" />
            <div className="row">
              <button className="btn" data-p="1" onClick={async () => { await api.saveSettings(s); setOpenSettings(false); toast("Limits saved"); }}>
                Save limits
              </button>
              <button className="btn" data-ghost="1" onClick={() => { setS(settings); setOpenSettings(false); }}>Cancel</button>
              <button className="btn btn-sm" data-ghost="1" style={{ marginLeft: "auto" }} onClick={() => setS({ ...DEFAULT_SETTINGS })}>
                Back to SOP defaults
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ==========================================================================
   SHELL
   ========================================================================== */

const TABS = [
  ["wall", "Wall"],
  ["taste", "Taste"],
  ["taps", "Taps"],
  ["panel", "Panel"],
  ["data", "Data"],
];

function IdentitySheet({ tasters, meId, onPick, onClose, api }) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const active = tasters.filter((t) => t.active);
  const addMe = async () => {
    const t = { id: uid(), name: name.trim(), title: title.trim(), active: true, trainee: false };
    await api.saveTaster(t);
    onPick(t.id);
    onClose();
  };
  return (
    <Sheet title="Who is holding this phone?" sub="Saved on this device only. Everyone scores as themselves." onClose={onClose}>
      {active.length > 0 && (
        <div className="stack" style={{ gap: 8, marginBottom: 18 }}>
          {active.map((t) => (
            <button key={t.id} className="card" style={{ borderColor: t.id === meId ? "var(--foam)" : undefined }}
              onClick={() => { onPick(t.id); onClose(); }}>
              <div className="row">
                <div className="av" data-on={t.id === meId ? "1" : "0"} style={{ marginRight: 4 }}>{initials(t.name)}</div>
                <div>
                  <b style={{ fontSize: 14.5 }}>{t.name || "Unnamed"}</b>
                  <div className="dim" style={{ fontSize: 12 }}>{t.title || "panelist"}{t.trainee ? " · trainee" : ""}</div>
                </div>
                {t.id === meId && <span className="chip" data-t="solid" style={{ marginLeft: "auto" }}>you</span>}
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="card">
        <div className="eyebrow" style={{ marginBottom: 9 }}>{active.length ? "Not on the list?" : "Add the first panelist"}</div>
        <div className="row" style={{ gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" style={{ flex: 2, minWidth: 130 }} />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" style={{ flex: 2, minWidth: 110 }} />
          <button className="btn" data-p="1" disabled={!name.trim()} onClick={addMe}>Add</button>
        </div>
      </div>
    </Sheet>
  );
}

export default function App() {
  const { taps, tasters, results, sessions, settings, ready, sync, parked, archive, api } = useCloud();
  /* The live feed covers the last 210 days so the wall stays quick. Pulling
     the archive widens every curve and every report in the app, not just the
     CSV, so the freshness fits stop being clipped at seven months. */
  const allResults = useMemo(() => {
    if (!archive) return results;
    const cutoff = shiftISO(todayISO(), -210);
    const seen = new Set(results.map((r) => r.id));
    return [...archive.filter((r) => r.date < cutoff && !seen.has(r.id)), ...results];
  }, [archive, results]);
  const [tab, setTab] = useState("wall");
  const [meId, setMeId] = useState(() => local.get(LS_ME, null));
  const [pickMe, setPickMe] = useState(false);
  const [pendingKind, setPendingKind] = useState(null);
  const [toastNode, toast] = useToast();

  const me = useMemo(() => tasters.find((t) => t.id === meId) || null, [tasters, meId]);
  const a = useMemo(() => analyze(taps, allResults, settings), [taps, allResults, settings]);
  const signals = useMemo(() => buildSignals(a, taps, allResults, settings), [a, taps, allResults, settings]);

  const setMe = useCallback((id) => { setMeId(id); local.set(LS_ME, id); }, []);

  /* First run on a device with a panel already in the cloud: if there is
     exactly one active panelist, that is almost certainly who this is. */
  useEffect(() => {
    if (!meId && tasters.filter((t) => t.active).length === 1) setMe(tasters.find((t) => t.active).id);
  }, [meId, tasters, setMe]);

  const startSession = useCallback((kind) => {
    if (!me) { setPendingKind(kind); setPickMe(true); return; }
    setPendingKind(kind);
    setTab("taste");
  }, [me]);

  /* Anything that pins below the header needs to know how tall it is, and
     that changes with the breakpoint and again when the fonts land. */
  const topRef = useCallback((node) => {
    if (!node || typeof document === "undefined") return;
    const apply = () => document.documentElement.style.setProperty("--top-h", `${node.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  if (!ready) {
    return (
      <div className="lc">
        <style>{CSS}</style>
        <div className="wrap" style={{ paddingTop: 90, maxWidth: 520 }}>
          <div style={{ fontFamily: "var(--gauge)", fontSize: 34, fontWeight: 600, letterSpacing: "-0.03em" }}>Line Check</div>
          <div className="pip" data-s="connecting" style={{ marginTop: 14 }}><i />opening the cellar</div>
        </div>
      </div>
    );
  }

  const syncLabel = sync === "live" ? (parked ? `${parked} waiting` : "live")
    : sync === "offline" ? (parked ? `${parked} waiting` : "offline")
    : "connecting";

  return (
    <div className="lc">
      <style>{CSS}</style>

      <header className="top" ref={topRef}>
        <div className="top-in">
          <div className="mark">
            <b>Line Check</b>
            <span>Oakley</span>
          </div>
          <div className="pip" data-s={sync === "live" && !parked ? "live" : sync === "connecting" ? "connecting" : "offline"} title="Cloud sync">
            <i />{syncLabel}
          </div>
          <nav className="nav" aria-label="Sections">
            {TABS.map(([k, l]) => (
              <button key={k} data-on={tab === k ? "1" : "0"} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>{l}</button>
            ))}
          </nav>
          <button className="btn btn-sm me-btn" onClick={() => setPickMe(true)}>
            {me ? (
              <>
                <span className="av" style={{ width: 18, height: 18, fontSize: 8, marginRight: 2 }}>{initials(me.name)}</span>
                {me.name.split(" ")[0]}
              </>
            ) : "Sign in"}
          </button>
        </div>
      </header>

      <main className="wrap">
        {sync === "offline" && (
          <div className="sig" data-sev="watch" style={{ marginTop: 16 }}>
            <div className="sig-ic">!</div>
            <div>
              <div className="sig-t">Working offline</div>
              <div className="sig-d">
                {parked
                  ? `${parked} ${parked === 1 ? "score is" : "scores are"} held on this phone and will go up the moment the connection comes back. Keep tasting.`
                  : "The cloud is not answering. Anything you score is held on this phone until it does."}
              </div>
            </div>
          </div>
        )}

        {tab === "wall" && (
          <Wall
            a={a} taps={taps} tasters={tasters} settings={settings} results={allResults}
            signals={signals} me={me} api={api} toast={toast} onStart={startSession}
          />
        )}

        {tab === "taste" && (
          <Session
            taps={taps} tasters={tasters} a={a} settings={settings} me={me}
            results={allResults} sessions={sessions} api={api}
            kind={pendingKind} clearKind={() => setPendingKind(null)}
            onExit={() => setTab("wall")} onPickMe={() => setPickMe(true)} toast={toast}
          />
        )}

        {tab === "taps" && <Taps taps={taps} settings={settings} api={api} toast={toast} />}

        {tab === "panel" && (
          <Panel tasters={tasters} a={a} api={api} me={me} onPickMe={() => setPickMe(true)} toast={toast} />
        )}

        {tab === "data" && (
          <Data a={a} results={allResults} taps={taps} tasters={tasters} settings={settings} api={api} archive={archive} toast={toast} />
        )}
      </main>

      <nav className="navbar" aria-label="Sections">
        {TABS.map(([k, l]) => (
          <button key={k} data-on={tab === k ? "1" : "0"} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>
            <b>{k === "wall" ? (signals.length || "\u00b7") : k === "taste" ? "\u25b8" : k === "taps" ? taps.filter((t) => t.active && !t.onDeck).length : k === "panel" ? tasters.filter((t) => t.active).length : "\u2211"}</b>
            <span>{l}</span>
          </button>
        ))}
      </nav>

      {pickMe && (
        <IdentitySheet
          tasters={tasters} meId={meId} api={api}
          onPick={(id) => {
            setMe(id);
            if (pendingKind) setTab("taste");
          }}
          onClose={() => setPickMe(false)}
        />
      )}

      {toastNode}
    </div>
  );
}
