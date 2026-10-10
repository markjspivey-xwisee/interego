// Runtime capabilities: who is viewing (user), the team's shared ballots/notes/usage (db), each viewer's
// private workspace (db data/users/<id>, else browser storage), Ask Claude (sample) and file saves
// (downloads). Every capability is optional: the page renders fully without any of them.
/* global React */
import { store } from "./util.js";
import { ITEMS, itemByKey } from "./data.js";

const { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, createElement: h } = React;

export const CapsContext = createContext(null);
export const useCaps = () => useContext(CapsContext);

const EMPTY_WS = { packs: [], stars: [], recents: [] };
const DEFAULT_POLICY = { quorum: 2 };

const docsToMap = (snap) => {
  const m = new Map();
  for (const d of snap.docs) if (d.exists) m.set(d.id, d.data() || {});
  return m;
};

async function resolveCap(name) {
  try {
    if (!window.claude || typeof window.claude.use !== "function") return null;
    return await window.claude.use(name);
  } catch {
    return null;
  }
}

export function CapsProvider({ children }) {
  const [caps, setCaps] = useState({ db: null, user: null, sample: null, downloads: null, resolved: false });
  const [me, setMe] = useState(null);
  const [canWrite, setCanWrite] = useState(null);
  const [ballots, setBallots] = useState(() => new Map());
  const [notes, setNotes] = useState(() => new Map());
  const [usage, setUsage] = useState(() => new Map());
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [ws, setWs] = useState(() => ({ ...EMPTY_WS, ...store.get("workspace", EMPTY_WS) }));
  const [wsSource, setWsSource] = useState("local"); // "local" | "db"
  const [tools, setTools] = useState(false);
  const [dbError, setDbError] = useState(null);
  const chains = useRef(new Map()); // path → promise chain (one write at a time per document)
  const wsTimer = useRef(null);
  const wsPending = useRef(false);
  const migrated = useRef(false);

  // Resolve capabilities once; light features up as each arrives.
  useEffect(() => {
    let live = true;
    (async () => {
      const [db, user, sample, downloads] = await Promise.all(["db", "user", "sample", "downloads"].map(resolveCap));
      if (!live) return;
      setCaps({ db, user, sample, downloads, resolved: true });
      if (user) {
        try {
          const m = await user.me();
          if (live) setMe(m && m.id ? m : null);
          const w = await user.can("data.write").catch(() => null);
          if (live) setCanWrite(w);
        } catch { /* identity unavailable */ }
      }
      if (sample && sample.limits) {
        try { const l = await sample.limits(); if (live) setTools(!!(l && l.tools)); } catch { /* no tools */ }
      }
    })();
    return () => { live = false; };
  }, []);

  // Subscribe once to the shared collections (and this viewer's private workspace).
  const myId = me ? me.id : null;
  useEffect(() => {
    const db = caps.db;
    if (!db) return;
    const offs = [];
    const fail = (e) => setDbError(e && e.code ? e.code : "unavailable");
    try {
      offs.push(db.collection("ballots").onSnapshot((s) => setBallots(docsToMap(s)), fail));
      offs.push(db.collection("notes").onSnapshot((s) => setNotes(docsToMap(s)), fail));
      offs.push(db.collection("usage").onSnapshot((s) => setUsage(docsToMap(s)), fail));
      offs.push(db.doc("settings/policy").onSnapshot((s) => setPolicy(s.exists ? { ...DEFAULT_POLICY, ...s.data() } : DEFAULT_POLICY), fail));
      if (myId) {
        offs.push(db.doc(`data/users/${myId}/workspace`).onSnapshot((s) => {
          if (wsPending.current || s.metadata.hasPendingWrites) return;
          if (s.exists) {
            setWs({ ...EMPTY_WS, ...s.data() });
            setWsSource("db");
          } else {
            setWsSource("db-empty");
          }
        }, fail));
      }
    } catch (e) {
      fail(e);
    }
    return () => offs.forEach((off) => { try { off(); } catch { /* already closed */ } });
  }, [caps.db, myId]);

  // First visit with a signed-in identity: carry what this browser already kept into the private doc.
  useEffect(() => {
    if (wsSource !== "db-empty" || migrated.current || !caps.db || !myId || canWrite === false) return;
    migrated.current = true;
    const local = store.get("workspace", EMPTY_WS);
    if ((local.packs || []).length || (local.stars || []).length) {
      write(`data/users/${myId}/workspace`, { ...EMPTY_WS, ...local }).catch(() => {});
    }
    setWsSource("db");
  }, [wsSource, caps.db, myId, canWrite]);

  const write = useCallback((path, body) => {
    const db = caps.db;
    if (!db) return Promise.reject({ code: "unavailable" });
    const prev = chains.current.get(path) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => db.doc(path).set(body)).catch((e) => {
      if (e && e.code === "invalid_argument") setCanWrite(false);
      throw e;
    });
    chains.current.set(path, next);
    return next;
  }, [caps.db]);

  const signedIn = !!(caps.db && myId);
  const writable = signedIn && canWrite !== false;

  // ── Ballots ─────────────────────────────────────────────────────────────────────────────────
  const myBallot = (myId && ballots.get(myId)) || { v: {} };
  const vote = useCallback(async (key, choice, note) => {
    if (!writable) throw { code: "read_only" };
    const cur = { ...((ballots.get(myId) || {}).v || {}) };
    if (!choice) delete cur[key];
    else cur[key] = { vote: choice, note: (note || "").slice(0, 600), at: Date.now() };
    setBallots((m) => new Map(m).set(myId, { v: cur }));
    await write(`ballots/${myId}`, { v: cur });
  }, [writable, ballots, myId, write]);

  const tallies = useMemo(() => {
    const t = new Map(ITEMS.map((i) => [i.key, { for: [], against: [], abstain: [], notes: [] }]));
    for (const [u, doc] of ballots) {
      for (const [k, v] of Object.entries((doc && doc.v) || {})) {
        const x = t.get(k);
        if (!x || !v || !x[v.vote]) continue;
        x[v.vote].push(u);
        if (v.note) x.notes.push({ u, vote: v.vote, note: v.note, at: v.at });
      }
    }
    return t;
  }, [ballots]);

  // ── Notes ───────────────────────────────────────────────────────────────────────────────────
  const allNotes = useMemo(() => {
    const out = [];
    for (const [u, doc] of notes) for (const [id, n] of Object.entries((doc && doc.n) || {})) if (n && n.c) out.push({ id, u, ...n });
    out.sort((a, b) => (a.at || 0) - (b.at || 0));
    return out;
  }, [notes]);
  const addNote = useCallback(async (c, text) => {
    if (!writable) throw { code: "read_only" };
    const cur = { ...((notes.get(myId) || {}).n || {}) };
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    cur[id] = { c, text: text.slice(0, 2000), at: Date.now() };
    setNotes((m) => new Map(m).set(myId, { n: cur }));
    await write(`notes/${myId}`, { n: cur });
  }, [writable, notes, myId, write]);
  const deleteNote = useCallback(async (id) => {
    if (!writable) throw { code: "read_only" };
    const cur = { ...((notes.get(myId) || {}).n || {}) };
    delete cur[id];
    setNotes((m) => new Map(m).set(myId, { n: cur }));
    await write(`notes/${myId}`, { n: cur });
  }, [writable, notes, myId, write]);

  // ── Usage ───────────────────────────────────────────────────────────────────────────────────
  const usageByConcept = useMemo(() => {
    const m = new Map();
    for (const [u, doc] of usage) {
      for (const [c, v] of Object.entries((doc && doc.u) || {})) {
        if (!m.has(c)) m.set(c, []);
        m.get(c).push({ u, ctx: (v && v.ctx) || "", at: v && v.at });
      }
    }
    return m;
  }, [usage]);
  const setUse = useCallback(async (c, ctx) => {
    if (!writable) throw { code: "read_only" };
    const cur = { ...((usage.get(myId) || {}).u || {}) };
    if (ctx == null) delete cur[c];
    else cur[c] = { ctx: String(ctx).slice(0, 140), at: Date.now() };
    setUsage((m) => new Map(m).set(myId, { u: cur }));
    await write(`usage/${myId}`, { u: cur });
  }, [writable, usage, myId, write]);

  // ── Policy (editors) ────────────────────────────────────────────────────────────────────────
  const savePolicy = useCallback(async (p) => {
    const next = { ...policy, ...p };
    setPolicy(next);
    await write("settings/policy", next);
  }, [policy, write]);

  // ── Workspace: packs, stars, recents ────────────────────────────────────────────────────────
  const updateWs = useCallback((fn) => {
    setWs((old) => {
      const next = { ...old, ...fn(old) };
      store.set("workspace", next);
      if (caps.db && myId && canWrite !== false) {
        wsPending.current = true;
        clearTimeout(wsTimer.current);
        wsTimer.current = setTimeout(() => {
          write(`data/users/${myId}/workspace`, next).catch(() => {}).finally(() => { wsPending.current = false; });
        }, 700);
      }
      return next;
    });
  }, [caps.db, myId, canWrite, write]);

  // ── Files ───────────────────────────────────────────────────────────────────────────────────
  const save = useCallback(async (filename, data) => {
    if (!caps.downloads) throw { code: "unavailable" };
    return caps.downloads.save({ filename, data });
  }, [caps.downloads]);

  const value = {
    resolved: caps.resolved, db: caps.db, user: caps.user, sample: caps.sample, downloads: caps.downloads, tools,
    me, myId, signedIn, writable, canWrite, isOwner: !!(me && me.isOwner), canEdit: !!(me && me.canEdit), dbError,
    items: ITEMS, itemByKey, ballots, myBallot, tallies, vote, policy, savePolicy,
    allNotes, addNote, deleteNote, usageByConcept, setUse,
    ws, wsSource, updateWs, save,
  };
  return h(CapsContext.Provider, { value }, children);
}

/** Resolve display names for the ids on screen (cheap and cached by contract — call freely). */
export function useProfiles(ids) {
  const { user } = useCaps();
  const key = [...new Set(ids)].sort().join(",");
  const [map, setMap] = useState({});
  useEffect(() => {
    if (!user || !key) return;
    let live = true;
    user.profiles(key.split(",")).then((m) => { if (live) setMap(m || {}); }).catch(() => {});
    return () => { live = false; };
  }, [user, key]);
  return map;
}

export function consensus(t, quorum) {
  const f = t.for.length, a = t.against.length, x = t.abstain.length;
  if (f >= quorum && f > a) return "ratified";
  if (a >= quorum && a > f) return "rejected";
  if (f && a) return "contested";
  if (f || a || x) return "in-review";
  return "proposed";
}
export const CONSENSUS_LABEL = { proposed: "Needs votes", "in-review": "In review", contested: "Contested", ratified: "Ratified here", rejected: "Rejected here" };
