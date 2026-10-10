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
// This browser's copies of the workspace: one per signed-in viewer (a copy of their private document) and
// one for signed-out use. Nothing kept for one account is read for another account in the same browser.
const ANON_WS = "workspace.anon";
const wsKey = (id) => (id ? "workspace.u." + id : ANON_WS);
// A signed-in viewer's changes that their document has not confirmed, kept as changes (packs put or dropped by
// id, stars added or removed), so they can be made again on top of whatever the document holds: a merge, never
// a whole-copy write over a document the page has not seen.
const draftKey = (id) => wsKey(id) + ".held";
const NO_CHANGE = { put: [], drop: [], star: [], unstar: [] };
const changeOf = (base, next) => {
  const before = new Map((base.packs || []).map((x) => [x.id, x]));
  const after = new Set((next.packs || []).map((x) => x.id));
  return {
    put: (next.packs || []).filter((x) => JSON.stringify(before.get(x.id)) !== JSON.stringify(x)),
    drop: [...before.keys()].filter((id) => !after.has(id)),
    star: (next.stars || []).filter((id) => !(base.stars || []).includes(id)),
    unstar: (base.stars || []).filter((id) => !(next.stars || []).includes(id)),
  };
};
const withChange = (w, c) => {
  const put = new Map(c.put.map((x) => [x.id, x]));
  const packs = w.packs || [], stars = w.stars || [];
  return {
    packs: [...c.put.filter((x) => !packs.some((y) => y.id === x.id)), ...packs.filter((x) => !c.drop.includes(x.id)).map((x) => put.get(x.id) || x)],
    stars: [...c.star.filter((id) => !stars.includes(id)), ...stars.filter((id) => !c.unstar.includes(id))],
  };
};
// b after a: the later put of a pack wins, a drop cancels an earlier put, a star cancels an earlier unstar.
const compose = (a, b) => {
  const later = new Set(b.put.map((x) => x.id));
  return {
    put: [...b.put, ...a.put.filter((x) => !later.has(x.id))].filter((x) => !b.drop.includes(x.id)),
    drop: [...new Set([...a.drop.filter((id) => !later.has(id)), ...b.drop])],
    star: [...new Set([...b.star, ...a.star.filter((id) => !b.unstar.includes(id))])],
    unstar: [...new Set([...a.unstar.filter((id) => !b.star.includes(id)), ...b.unstar])],
  };
};
const hasWork = (w) => !!w && ((w.packs || []).length > 0 || (w.stars || []).length > 0);
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
  const [idDone, setIdDone] = useState(false); // whether we know who is viewing (or that no one is signed in)
  const [ws, setWs] = useState(EMPTY_WS);
  // "pending" until known, then "local" (signed out) | "db"; "held" when a signed-in viewer's document cannot be
  // reached (no database this visit, or the subscription failed): edits are kept as a change until it can be.
  const [wsSource, setWsSource] = useState("pending");
  const [tools, setTools] = useState(false);
  const [dbError, setDbError] = useState(null);
  const chains = useRef(new Map()); // path → promise chain (one write at a time per document)
  const wsTimer = useRef(null);
  const wsNext = useRef(null); // the save the debounce is holding: { path, body }
  const wsPending = useRef(false);
  const wsQueue = useRef([]); // edits made before the workspace is known, applied on top of it once it is
  const wsReady = useRef(false); // whether the workspace is known (who is viewing; signed in, the server's document)
  const heldBase = useRef(EMPTY_WS); // what the held edits are shown on top of while the workspace is not known
  const replayed = useRef(null); // the viewer whose interrupted session's held edits have been queued again

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
        } catch { /* identity unavailable */ }
      }
      if (live) setIdDone(true);
      if (user) {
        const w = await user.can("data.write").catch(() => null);
        if (live) setCanWrite(w);
      }
      if (sample && sample.limits) {
        try { const l = await sample.limits(); if (live) setTools(!!(l && l.tools)); } catch { /* no tools */ }
      }
    })();
    return () => { live = false; };
  }, []);

  // Subscribe once to the shared collections.
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
    } catch (e) {
      fail(e);
    }
    return () => offs.forEach((off) => { try { off(); } catch { /* already closed */ } });
  }, [caps.db]);

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
  // Signed out, the workspace is this browser's own copy. Signed in, it is the viewer's private document
  // (data/users/<id>/workspace). This browser keeps a copy of it under the viewer's own key, to show while the
  // document loads, and keeps every change the document has not confirmed as a change (see draftKey). A change
  // is never written as a whole copy over a document the page has not seen: it is made again on top of what
  // the server's document holds once the page has that (this visit, after a reload, or after a visit with no
  // database), so another device's edits survive, and a save that failed is retried the same way. Until the
  // workspace is known, edits are shown at once and held. An edit made in the moment before the page knows
  // who is viewing cannot be attributed to anyone, so it lives only in the page.
  const latest = useRef({});
  latest.current = { myId, canWrite, db: caps.db, write, idDone };
  const lastBody = useRef(null); // the newest workspace this page produced, to know when a landed save is the latest
  const deferred = useRef(false); // whether a snapshot arrived while a save was in flight
  const onDoc = useRef(null); // the snapshot handler for this viewer's document
  const pathOf = (id) => `data/users/${id}/workspace`;
  const applyHeld = (base) => wsQueue.current.reduce((w, fn) => ({ ...w, ...fn(w) }), { ...EMPTY_WS, ...base });
  const tidy = (w) => {
    const seen = new Set();
    return { ...w, stars: [...new Set(w.stars || [])], packs: (w.packs || []).filter((x) => x && !seen.has(x.id) && seen.add(x.id)) };
  };
  // Add what one edit changed (from the workspace before it to the one after) to the changes kept for a viewer.
  const keepChange = (id, before, after) => {
    if (!id) return;
    const kept = store.get(draftKey(id), null);
    store.set(draftKey(id), { change: compose((kept && kept.change) || NO_CHANGE, changeOf(before, after)), at: Date.now() });
  };
  const replayKept = (id) => {
    const kept = id ? store.get(draftKey(id), null) : null;
    if (kept && kept.change) wsQueue.current.unshift((w) => withChange(w, kept.change));
  };

  // Send a workspace to the document. Once it lands, if nothing newer was made meanwhile, there are no changes
  // left to keep; if it does not land, they stay kept. Snapshots that arrive while a save is in flight may
  // predate it, so they are set aside and the document is read again once it settles.
  const send = (id, body) => latest.current.write(pathOf(id), body).then(() => {
    if (lastBody.current === body) store.del(draftKey(id));
  }).catch(() => {});
  const push = (id, body) => {
    wsPending.current = true;
    return send(id, body).finally(() => {
      if (wsNext.current) return;
      wsPending.current = false;
      if (!deferred.current) return;
      deferred.current = false;
      const { db } = latest.current;
      if (db) db.doc(pathOf(id)).get().then((snap) => { if (onDoc.current) onDoc.current(snap); }).catch(() => {});
    });
  };

  // The workspace is known: apply the held edits on top of it, keep the result, and, signed in, send it when it
  // differs from what the server holds (serverHas: the document, or nothing when there is none yet).
  const settle = (start, source, serverHas) => {
    const { myId: id, canWrite: cw, db } = latest.current;
    const held = wsQueue.current;
    wsQueue.current = [];
    let next = { ...EMPTY_WS, ...start };
    for (const fn of held) next = { ...next, ...fn(next) };
    if (held.length) next = tidy({ ...next, at: Date.now() });
    wsReady.current = true;
    lastBody.current = next;
    setWs(next);
    setWsSource(source);
    store.set(wsKey(id), next);
    if (source !== "db" || !id) return;
    if (!held.length && start === serverHas) { store.del(draftKey(id)); return; }
    // What is sent is the document with the kept changes made again on it (and, with no document yet, what this
    // browser carried in); the changes stay kept until it lands.
    keepChange(id, serverHas, next);
    if (db && cw !== false) push(id, next);
  };

  // Once we know who is viewing: signed out, the workspace is this browser's copy; signed in, show their copy
  // with any change kept from an earlier visit while their document loads, or, with no database this visit,
  // hold everything.
  useEffect(() => {
    if (!idDone) return;
    store.del("workspace"); // earlier versions kept one unscoped copy for every viewer of this browser
    const own = { ...EMPTY_WS, ...store.get(wsKey(myId), EMPTY_WS) };
    if (!myId) { settle(own, "local", null); return; }
    // Edits made before we knew who was viewing are this viewer's now: keep them, on top of any changes kept
    // from an earlier visit, which are made again first.
    const early = wsQueue.current.slice();
    if (replayed.current !== myId) { replayed.current = myId; replayKept(myId); }
    wsReady.current = false;
    heldBase.current = own;
    const shown = applyHeld(own);
    if (early.length) {
      const replay = wsQueue.current.slice(0, wsQueue.current.length - early.length);
      keepChange(myId, replay.reduce((w, fn) => ({ ...w, ...fn(w) }), own), shown);
    }
    setWs(shown);
    setWsSource(caps.db ? "pending" : "held");
  }, [idDone, myId, caps.db]);

  useEffect(() => {
    const db = caps.db;
    if (!db || !myId || !idDone) return undefined;
    let off = null;
    // The document cannot be read: keep holding edits (shown, and kept as a change) rather than writing a copy
    // that never saw the server's, so they are made again on top of the document when it can be read.
    const fallBack = (e) => {
      setDbError(e && e.code ? e.code : "unavailable");
      if (!wsReady.current) setWsSource("held");
    };
    const handle = (s) => {
      if (s.metadata && s.metadata.hasPendingWrites) return; // includes this page's own unconfirmed write
      if (wsPending.current) { deferred.current = true; return; } // a save is in flight: read again after it
      const remote = s.exists ? { ...EMPTY_WS, ...s.data() } : null;
      if (s.metadata && s.metadata.fromCache) {
        // From the client's own cache, perhaps stale: show it with what is held, and decide nothing (no write,
        // no "no document yet") until the server's definitive snapshot, which follows on its own.
        if (!wsReady.current && remote) { heldBase.current = remote; setWs(applyHeld(remote)); }
        return;
      }
      // A change kept from a save that did not land is made again on top of this document. (While the
      // workspace is still being settled, the held edits already include it.)
      if (wsReady.current && !wsQueue.current.length) replayKept(myId);
      if (remote) { settle(remote, "db", remote); return; }
      // No document yet: start it from this viewer's own copy, else from what this browser kept while signed
      // out, which moves (not copies) into the first account that signs in here.
      const own = store.get(wsKey(myId), null);
      const anon = store.get(ANON_WS, null);
      const carry = latest.current.canWrite === false ? null : hasWork(own) ? own : hasWork(anon) ? anon : null;
      if (carry && carry === anon) store.del(ANON_WS);
      settle(carry || EMPTY_WS, "db", EMPTY_WS);
    };
    onDoc.current = handle;
    try {
      off = db.doc(pathOf(myId)).onSnapshot(handle, fallBack);
    } catch (e) {
      fallBack(e);
    }
    return () => {
      onDoc.current = null;
      try { if (off) off(); } catch { /* already closed */ }
    };
  }, [caps.db, myId, idDone]);

  // Send the save the debounce is holding now. Also run when the page is hidden or closed, so an edit made just
  // before goes out; if it still does not land, it stays kept as a change and is made again next time.
  const sendWs = useCallback(() => {
    clearTimeout(wsTimer.current);
    wsTimer.current = null;
    const job = wsNext.current;
    wsNext.current = null;
    if (!job) return;
    push(job.id, job.body);
  }, [write]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") sendWs(); };
    window.addEventListener("pagehide", sendWs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", sendWs);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sendWs]);

  const updateWs = useCallback((fn) => {
    if (!wsReady.current) {
      wsQueue.current.push(fn);
      setWs((old) => {
        const next = { ...old, ...fn(old), at: Date.now() };
        const { myId: id, idDone: known } = latest.current;
        if (known && id) keepChange(id, old, next);
        return next;
      });
      return;
    }
    setWs((old) => {
      const next = { ...old, ...fn(old), at: Date.now() };
      lastBody.current = next;
      store.set(wsKey(myId), next);
      if (myId) {
        keepChange(myId, old, next);
        if (caps.db && canWrite !== false) {
          wsPending.current = true;
          wsNext.current = { id: myId, body: next };
          clearTimeout(wsTimer.current);
          wsTimer.current = setTimeout(sendWs, 700);
        }
      }
      return next;
    });
  }, [caps.db, myId, canWrite, sendWs]);

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
