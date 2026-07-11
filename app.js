const {
  useState,
  useEffect,
  useRef,
  useCallback
} = React;
let SEED = {
  people: [],
  edges: [],
  photos: {},
  log: []
};

// ====================== Firebase (live shared tree) ======================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCVvZxJW2VXT3dcaAlIEKiq9UxZ3Xo1jjw",
  authDomain: "family-tree-alwazrah.firebaseapp.com",
  projectId: "family-tree-alwazrah",
  storageBucket: "family-tree-alwazrah.firebasestorage.app",
  messagingSenderId: "203702835559",
  appId: "1:203702835559:web:3a09a8fcf403afe65fb7c2"
};
const ADMIN_EMAIL = "alhammad.md@gmail.com";
let FB = null;
try {
  if (typeof firebase !== "undefined" && firebase.initializeApp) {
    firebase.initializeApp(FIREBASE_CONFIG);
    FB = {
      db: firebase.firestore(),
      auth: firebase.auth()
    };
  }
} catch (e) {
  console.error("firebase init failed", e);
}

// data is stored in a few chunked documents (not one per person) to stay
// far inside Firestore's free read quota: ~30 doc reads per visit
const PEOPLE_CHUNKS = 8,
  EDGE_CHUNKS = 4,
  PHOTO_CHUNKS = 24;
const chunkOf = (id, n) => {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) >>> 0;
  return h % n;
};
const FV = () => firebase.firestore.FieldValue;

// ====================== Storage helpers ======================
const hasStore = typeof window !== "undefined" && window.storage;
const mem = {};
const store = {
  async get(k) {
    if (!hasStore) return mem[k] ?? null;
    try {
      const r = await window.storage.get(k);
      return r ? r.value : null;
    } catch {
      return null;
    }
  },
  async set(k, v) {
    if (!hasStore) {
      mem[k] = v;
      return;
    }
    try {
      await window.storage.set(k, v);
    } catch (e) {
      console.error(e);
    }
  },
  async del(k) {
    if (!hasStore) {
      delete mem[k];
      return;
    }
    try {
      await window.storage.delete(k);
    } catch {}
  },
  async list(prefix) {
    if (!hasStore) return Object.keys(mem).filter(x => x.startsWith(prefix));
    try {
      const r = await window.storage.list(prefix);
      return r ? r.keys : [];
    } catch {
      return [];
    }
  }
};
const TREE_KEY = "ft:tree";
const LOG_KEY = "ft:log";
const FAMILY_KEY = "ft:family";
const SEEDV_KEY = "ft:seedv";
const photoKey = id => `ft:photo:${id}`;

// family mode passcode — stored as a SHA-256 hash only.
// to change the code: open the browser console and run  await sha256hex("الرمز الجديد")
// then paste the result here.
const FAMILY_CODE_HASH = "cf0718bf938dd7cbcc42d8d381d15172dc001f5595be34d6ea557004524d149d";
async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
window.sha256hex = sha256hex;

// Arabic-insensitive matching (hamza forms, taa marbuta, alef maqsura, diacritics)
const normAr = s => String(s || "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[ً-ْٰ]/g, "").trim();
const yearOf = d => {
  const m = String(d || "").match(/\d{4}/);
  return m ? +m[0] : null;
};
function ageOf(p) {
  const by = yearOf(p.dob);
  if (by == null) return null;
  const ey = p.deceased ? yearOf(p.dod) : new Date().getFullYear();
  return ey != null && ey >= by ? ey - by : null;
}
const mercy = p => p.gender === "f" ? "رحمها الله" : "رحمه الله";
const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const fmtDate = v => {
  const m = String(v || "").match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return v || "";
  return (m[3] ? +m[3] + " " : "") + (m[2] ? AR_MONTHS[+m[2] - 1] + " " : "") + m[1];
};
// approximate Hijri rendering of a (possibly partial) Gregorian date
const hijriOf = v => {
  const m = String(v || "").match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return "";
  try {
    const d = new Date(+m[1], m[2] ? +m[2] - 1 : 6, m[3] ? +m[3] : 15);
    const opts = m[3] ? {
      day: "numeric",
      month: "long",
      year: "numeric"
    } : m[2] ? {
      month: "long",
      year: "numeric"
    } : {
      year: "numeric"
    };
    return new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura", opts).format(d);
  } catch {
    return "";
  }
};
const waLink = v => {
  const d = String(v || "").replace(/\D/g, "");
  return d ? `https://wa.me/${d}` : null;
};
const liLink = v => {
  v = String(v || "").trim();
  return !v ? null : /^https?:/.test(v) ? v : `https://www.linkedin.com/in/${encodeURIComponent(v)}`;
};
const twLink = v => {
  v = String(v || "").trim().replace(/^@/, "");
  return !v ? null : /^https?:/.test(v) ? v : `https://x.com/${v}`;
};
const mailLink = v => {
  v = String(v || "").trim();
  return v && v.includes("@") ? `mailto:${v}` : null;
};

// per-field input restriction (strips disallowed characters as the user types)
const fieldFilters = {
  whatsapp: v => v.replace(/[^\d+ ]/g, ""),
  email: v => v.replace(/\s/g, ""),
  linkedin: v => v.replace(/\s/g, ""),
  twitter: v => v.replace(/\s/g, "")
};
// per-field validation (empty = valid; returns an Arabic error message otherwise)
const fieldValidators = {
  whatsapp: v => {
    if (!v) return "";
    const d = v.replace(/\D/g, "");
    return d.length >= 8 && d.length <= 15 ? "" : "أدخل رقمًا دوليًا صحيحًا (٨ إلى ١٥ رقمًا، مثل ‎+9665xxxxxxxx)";
  },
  email: v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? "" : "بريد إلكتروني غير صحيح",
  linkedin: v => {
    if (!v) return "";
    if (/^https?:\/\//.test(v)) return /linkedin\.com\//.test(v) ? "" : "الرابط يجب أن يكون من linkedin.com";
    return /^[A-Za-z0-9\-_.]{3,100}$/.test(v) ? "" : "أدخل اسم مستخدم صحيحًا أو رابط linkedin.com كاملًا";
  },
  twitter: v => {
    if (!v) return "";
    if (/^https?:\/\//.test(v)) return /(x\.com|twitter\.com)\//.test(v) ? "" : "الرابط يجب أن يكون من x.com";
    return /^@?[A-Za-z0-9_]{1,15}$/.test(v) ? "" : "اسم مستخدم غير صحيح (أحرف إنجليزية وأرقام و _ فقط)";
  }
};

// ====== Seed data (from transcription) ======

// ====================== Utilities ======================
const uid = () => Math.random().toString(36).slice(2, 10);
const NODE_W = 156;
const NODE_H = 150;

// 512px keeps single photos ~30-60KB so a 1MB photo-chunk document holds ~25 of them
function resizeImage(file, max = 512) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let {
          width: w,
          height: h
        } = img;
        const scale = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.72));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function fmtTime(ts) {
  try {
    return new Intl.DateTimeFormat("ar-SA", {
      dateStyle: "medium",
      timeStyle: "short",
      calendar: "gregory",
      numberingSystem: "latn"
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

// ====================== Main Component ======================
function FamilyTree() {
  const [people, setPeople] = useState([]);
  const [edges, setEdges] = useState([]);
  const [photos, setPhotos] = useState({});
  const [log, setLog] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [radialRoot, setRadialRoot] = useState(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState(null);
  const [tab, setTab] = useState("view"); // view | edit | log
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showPanel, setShowPanel] = useState(false);
  const [familyMode, setFamilyMode] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [updateAvail, setUpdateAvail] = useState(false);
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" && window.innerWidth < 700);

  // cloud / auth state — open editing model: any signed-in Google account can edit
  const [cloud, setCloud] = useState(FB ? "connecting" : "off"); // connecting | live | empty | off
  const [user, setUser] = useState(null);
  const [revisions, setRevisions] = useState([]); // cloud edit history
  const [busyMsg, setBusyMsg] = useState("");
  const [photosReady, setPhotosReady] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showGallery, setShowGallery] = useState(false);

  // view switcher: tree (collapsible, default) | list | focus | classic
  const [viewMode, setViewModeRaw] = useState(() => {
    try {
      return localStorage.getItem("ft:viewmode") || "tree";
    } catch {
      return "tree";
    }
  });
  const setViewMode = m => {
    setViewModeRaw(m);
    try {
      localStorage.setItem("ft:viewmode", m);
    } catch {}
  };
  const [treeCollapsed, setTreeCollapsed] = useState(null); // Set of collapsed node ids
  const [listOpen, setListOpen] = useState(null); // Set of expanded list rows
  const [focusId, setFocusId] = useState(null); // hourglass center

  const cloudLive = cloud === "live";
  const isAdmin = !!user && user.email === ADMIN_EMAIL;
  const isEditor = !!user;
  const canEdit = !cloudLive || isEditor;
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 700);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [view, setView] = useState({
    s: 1,
    tx: 0,
    ty: 0
  });
  const loadedRef = useRef(false);
  const canvasRef = useRef(null);
  const fileRef = useRef(null);
  const importRef = useRef(null);
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const saveTimer = useRef(null);

  // test/debug handle (the tree data is public anyway)
  useEffect(() => {
    window.__ftPeople = people;
  }, [people]);
  const treePosRef = useRef(null);
  const mainRootRef = useRef(null);
  const fitDoneRef = useRef("");

  // helper: father-preferred ancestor chain computed from raw state (usable in effects)
  const ancestorChainOf = id => {
    const pbc = {};
    edges.filter(e => e.type !== "spouse").forEach(e => (pbc[e.to] ||= []).push(e.from));
    const byId = {};
    people.forEach(p => {
      byId[p.id] = p;
    });
    const anc = [];
    let c = id,
      guard = 0;
    while (pbc[c] && guard++ < 25) {
      const f = pbc[c].find(x => byId[x]?.gender !== "f") || pbc[c][0];
      if (!f) break;
      anc.push(f);
      c = f;
    }
    return anc;
  };

  // default collapse/open state once data arrives: generations 0-2 visible, deeper folded
  useEffect(() => {
    if (loading || !people.length || treeCollapsed) return;
    const pbc = {},
      cm = {},
      pp = {};
    edges.filter(e => e.type !== "spouse").forEach(e => (pbc[e.to] ||= []).push(e.from));
    const byId = {};
    people.forEach(p => {
      byId[p.id] = p;
    });
    for (const c in pbc) {
      const f = pbc[c].find(x => byId[x]?.gender !== "f") || pbc[c][0];
      pp[c] = f;
      (cm[f] ||= []).push(c);
    }
    const col = new Set(),
      open = new Set();
    const walk = (id, d) => {
      const ks = cm[id] || [];
      if (ks.length) {
        if (d >= 3) col.add(id);
        if (d <= 1) open.add(id);
      }
      if (d < 15) ks.forEach(k => walk(k, d + 1));
    };
    people.filter(p => !pp[p.id]).forEach(r => walk(r.id, 0));
    setTreeCollapsed(col);
    setListOpen(open);
  }, [loading, people, edges, treeCollapsed]);

  // fit the viewport once per mode switch (deep links / reveals may override afterwards)
  useEffect(() => {
    fitDoneRef.current = "";
  }, [viewMode]);
  useEffect(() => {
    if (loading || fitDoneRef.current === viewMode) return;
    const r = canvasRef.current?.getBoundingClientRect();
    const w0 = r ? r.width : 900,
      h0 = r ? r.height : 600;
    if (viewMode === "classic") {
      const n0 = people[0];
      if (!n0) return;
      const s0 = w0 < 700 ? 1.1 : 0.62;
      setView({
        s: s0,
        tx: w0 / 2 - n0.x * s0,
        ty: Math.max(24, h0 * 0.16) - n0.y * s0
      });
    } else if (viewMode === "tree") {
      const q = treePosRef.current,
        rid = mainRootRef.current;
      if (!q || !rid || !q[rid]) return;
      const s0 = w0 < 700 ? 0.85 : 0.95;
      setView({
        s: s0,
        tx: w0 / 2 - q[rid].x * s0,
        ty: 70 - q[rid].y * s0
      });
    } else if (viewMode === "focus") {
      setView({
        s: w0 < 700 ? 0.8 : 0.95,
        tx: w0 / 2,
        ty: h0 * 0.42
      });
    } else if (viewMode === "list") {/* nothing to fit */}
    fitDoneRef.current = viewMode;
  }, [viewMode, loading, treeCollapsed, people]);

  // reveal the selected person in the active view (expand ancestors, center/scroll)
  useEffect(() => {
    if (!selectedId || loading) return;
    if (viewMode === "tree" && treeCollapsed) {
      const anc = ancestorChainOf(selectedId);
      if (anc.some(a => treeCollapsed.has(a))) {
        const ns = new Set(treeCollapsed);
        anc.forEach(a => ns.delete(a));
        setTreeCollapsed(ns);
        return; // effect re-runs and centers once layout is updated
      }
      const q = treePosRef.current?.[selectedId];
      if (q) {
        const r = canvasRef.current?.getBoundingClientRect();
        const w0 = r ? r.width : 900,
          h0 = r ? r.height : 600;
        setView(v => ({
          ...v,
          tx: w0 / 2 - q.x * v.s,
          ty: (isMobile ? h0 * 0.24 : h0 * 0.4) - q.y * v.s
        }));
      }
    } else if (viewMode === "list" && listOpen) {
      const anc = ancestorChainOf(selectedId);
      if (anc.some(a => !listOpen.has(a))) {
        const ns = new Set(listOpen);
        anc.forEach(a => ns.add(a));
        setListOpen(ns);
      }
      setTimeout(() => {
        document.getElementById("lrow-" + selectedId)?.scrollIntoView({
          block: "center",
          behavior: "smooth"
        });
      }, 100);
    } else if (viewMode === "focus") {
      setFocusId(selectedId);
    }
  }, [selectedId, viewMode, treeCollapsed, listOpen, loading]);

  // ---------- Family mode flag (independent of data source) ----------
  useEffect(() => {
    (async () => {
      const fm = await store.get(FAMILY_KEY);
      if (fm === FAMILY_CODE_HASH) setFamilyMode(true);
    })();
  }, []);

  // if the cloud can't be reached quickly, fall back to the static data
  // (a late successful connection still upgrades the app to live mode)
  useEffect(() => {
    if (!FB) return;
    const t = setTimeout(() => setCloud(c => c === "connecting" ? "off" : c), 6000);
    return () => clearTimeout(t);
  }, []);

  // ---------- Cloud: live tree subscription ----------
  useEffect(() => {
    if (!FB) return;
    const un = FB.db.collection("tree").onSnapshot(snap => {
      let meta = null;
      const pplMap = {},
        edgMap = {};
      snap.forEach(doc => {
        if (doc.id === "meta") {
          meta = doc.data();
          return;
        }
        if (doc.id.startsWith("people-")) Object.assign(pplMap, doc.data());else if (doc.id.startsWith("edges-")) Object.assign(edgMap, doc.data());
      });
      if (!meta) {
        // an empty from-cache snapshot means "offline", not "database is empty"
        const offline = snap.metadata && snap.metadata.fromCache;
        setCloud(c => c === "live" ? c : offline ? "off" : "empty");
        return;
      }
      const ppl = Object.values(pplMap).sort((a, b) => (a.g ?? 99) - (b.g ?? 99) || a.y - b.y || a.x - b.x);
      setPeople(ppl);
      setEdges(Object.values(edgMap));
      setCloud("live");
      setLoading(false);
      loadedRef.current = true;
    }, () => setCloud(c => c === "live" ? c : "off"));
    return un;
  }, []);

  // ---------- Cloud: photos subscription ----------
  useEffect(() => {
    if (!FB || !cloudLive) return;
    const un = FB.db.collection("photos").onSnapshot(snap => {
      const ph = {};
      snap.forEach(d => Object.assign(ph, d.data()));
      setPhotos(ph);
      setPhotosReady(true);
    }, () => {});
    return un;
  }, [cloudLive]);

  // ---------- Cloud: auth / history ----------
  useEffect(() => {
    if (FB) return FB.auth.onAuthStateChanged(u => setUser(u));
  }, []);
  useEffect(() => {
    if (!FB || !cloudLive) return;
    return FB.db.collection("revisions").orderBy("ts", "desc").limit(100).onSnapshot(s => {
      const a = [];
      s.forEach(d => a.push({
        id: d.id,
        ...d.data()
      }));
      setRevisions(a);
    }, () => {});
  }, [cloudLive]);

  // ---------- Local fallback (no cloud, or cloud not yet seeded) ----------
  const localLoadedRef = useRef(false);
  useEffect(() => {
    if (cloud !== "off" && cloud !== "empty") return;
    if (localLoadedRef.current) return;
    localLoadedRef.current = true;
    (async () => {
      const raw = await store.get(TREE_KEY);
      let p = [],
        e = [];
      if (raw) {
        try {
          const d = JSON.parse(raw);
          p = d.people || [];
          e = d.edges || [];
        } catch {}
      }
      const lg = await store.get(LOG_KEY);
      let logArr = [];
      if (lg) {
        try {
          logArr = JSON.parse(lg) || [];
        } catch {}
      }

      // First run (no stored data): seed from the transcription
      let seeded = false;
      if (p.length === 0 && e.length === 0) {
        p = SEED.people.map(n => ({
          ...n
        }));
        e = SEED.edges.map(x => ({
          ...x
        }));
        seeded = true;
      }
      setPeople(p);
      setEdges(e);
      if (seeded) {
        store.set(TREE_KEY, JSON.stringify({
          people: p,
          edges: e
        }));
        store.set(SEEDV_KEY, String(SEED.version || 1));
        logArr = [{
          id: "seed",
          ts: Date.now(),
          text: `تعبئة الشجرة من التفريغ (${p.length} فرد)`
        }];
        store.set(LOG_KEY, JSON.stringify(logArr));
      } else {
        // published data is newer than what this device was seeded with
        const sv = +(await store.get(SEEDV_KEY)) || 1;
        if ((SEED.version || 1) > sv) setUpdateAvail(true);
      }
      setLog(logArr);

      // photos: user uploads (from storage) sit on top of the seed pack below
      const ph = {
        ...SEED.photos
      };
      const keys = await store.list("ft:photo:");
      for (const k of keys) {
        const v = await store.get(k);
        if (v) ph[k.replace("ft:photo:", "")] = v;
      }
      setPhotos(prev => ({
        ...ph,
        ...prev
      }));
      setLoading(false);
      loadedRef.current = true;
    })();
  }, [cloud]);

  // ---------- Seed photo pack (only needed while not on the live cloud) ----------
  const photoPackRef = useRef(false);
  useEffect(() => {
    if (cloud !== "off" && cloud !== "empty") return;
    if (photoPackRef.current) return;
    photoPackRef.current = true;
    fetch("./family-tree-photos.json").then(r => r.ok ? r.json() : null).then(d => {
      if (!d || !d.photos) return;
      setPhotos(prev => ({
        ...d.photos,
        ...prev
      }));
      setPhotosReady(true);
    }).catch(() => {});
  }, [cloud]);

  // ---------- One-time view init (apex zoom + deep link), any data source ----------
  const viewInitRef = useRef(false);
  useEffect(() => {
    if (viewInitRef.current || loading || !people.length) return;
    viewInitRef.current = true;
    const r = canvasRef.current?.getBoundingClientRect();
    const vw0 = r ? r.width : 900,
      vh0 = r ? r.height : 600;
    const n0 = people[0] || {
      x: 0,
      y: 120
    };
    const s0 = vw0 < 700 ? 1.1 : 0.62;
    setView({
      s: s0,
      tx: vw0 / 2 - n0.x * s0,
      ty: Math.max(24, vh0 * 0.16) - n0.y * s0
    });
    const m = window.location.hash.match(/^#p=(.+)$/);
    const target = m && people.find(x => x.id === decodeURIComponent(m[1]));
    if (target && (target.gender !== "f" || familyMode)) {
      setSelectedId(target.id);
      setTab("view");
      setShowPanel(true);
      if (viewMode === "focus") setFocusId(target.id);
      if (viewMode === "classic") {
        setView({
          s: 1,
          tx: vw0 / 2 - target.x,
          ty: vh0 / 2 - target.y
        });
        fitDoneRef.current = "classic";
      }
    }
  }, [loading, people, familyMode]);

  // ---------- Keep #p=<id> in the URL for shareable links ----------
  useEffect(() => {
    if (!loadedRef.current) return;
    const url = selectedId ? "#p=" + encodeURIComponent(selectedId) : window.location.pathname + window.location.search;
    try {
      history.replaceState(null, "", url);
    } catch {}
  }, [selectedId]);

  // ---------- React to hash navigation while the app is open ----------
  useEffect(() => {
    const onHash = () => {
      const m = window.location.hash.match(/^#p=(.+)$/);
      if (!m) return;
      const id = decodeURIComponent(m[1]);
      if (id === selectedId) return;
      const t = people.find(x => x.id === id);
      if (!t || t.gender === "f" && !familyMode) return;
      setSelectedId(t.id);
      setTab("view");
      setShowPanel(true);
      if (viewMode === "focus") setFocusId(t.id);
      if (viewMode === "classic") {
        const r = canvasRef.current?.getBoundingClientRect();
        const w = r ? r.width : 900,
          h = r ? r.height : 600;
        setView({
          s: 1,
          tx: w / 2 - t.x,
          ty: h / 2 - t.y
        });
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [people, familyMode, selectedId]);

  // ---------- Persist tree locally (fallback mode only; the cloud is its own store) ----------
  useEffect(() => {
    if (!loadedRef.current || cloudLive) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      store.set(TREE_KEY, JSON.stringify({
        people,
        edges
      }));
    }, 400);
  }, [people, edges, cloudLive]);

  // ---------- Logging ----------
  const addLog = useCallback(text => {
    setLog(prev => {
      const next = [{
        id: uid(),
        ts: Date.now(),
        text
      }, ...prev].slice(0, 800);
      store.set(LOG_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // ====================== Family mode ======================
  const tryUnlock = async code => {
    const h = await sha256hex(code);
    if (h !== FAMILY_CODE_HASH) return false;
    setFamilyMode(true);
    setShowUnlock(false);
    store.set(FAMILY_KEY, h);
    addLog("تفعيل الوضع العائلي");
    return true;
  };
  const lockFamily = () => {
    setFamilyMode(false);
    store.del(FAMILY_KEY);
    setSelectedId(id => {
      const p = people.find(x => x.id === id);
      return p?.gender === "f" ? null : id;
    });
    addLog("قفل الوضع العائلي");
  };
  const applySeedUpdate = () => {
    if (!window.confirm("سيتم استبدال نسختك المحلية بالنسخة الرسمية الجديدة. تعديلاتك المحلية على الأسماء والروابط ستُفقد (صورك المرفوعة تبقى). هل تريد المتابعة؟")) return;
    const p = SEED.people.map(n => ({
      ...n
    }));
    const e = SEED.edges.map(x => ({
      ...x
    }));
    setPeople(p);
    setEdges(e);
    setSelectedId(null);
    store.set(TREE_KEY, JSON.stringify({
      people: p,
      edges: e
    }));
    store.set(SEEDV_KEY, String(SEED.version || 1));
    setUpdateAvail(false);
    addLog(`تحديث الشجرة إلى النسخة الرسمية (v${SEED.version || 1})`);
  };

  // ====================== Cloud write helpers ======================
  const cloudWritePeople = persons => {
    if (!cloudLive) return Promise.resolve();
    const byChunk = {};
    persons.forEach(p => {
      (byChunk[chunkOf(p.id, PEOPLE_CHUNKS)] ||= {})[p.id] = p;
    });
    const batch = FB.db.batch();
    Object.entries(byChunk).forEach(([c, m]) => batch.set(FB.db.doc("tree/people-" + c), m, {
      merge: true
    }));
    return batch.commit().catch(e => window.alert("تعذر الحفظ: " + (e.message || "")));
  };
  const cloudWriteEdges = es => {
    if (!cloudLive) return Promise.resolve();
    const byChunk = {};
    es.forEach(e => {
      (byChunk[chunkOf(e.id, EDGE_CHUNKS)] ||= {})[e.id] = e;
    });
    const batch = FB.db.batch();
    Object.entries(byChunk).forEach(([c, m]) => batch.set(FB.db.doc("tree/edges-" + c), m, {
      merge: true
    }));
    return batch.commit().catch(e => window.alert("تعذر الحفظ: " + (e.message || "")));
  };
  const cloudDeleteEdges = ids => {
    if (!cloudLive || !ids.length) return Promise.resolve();
    const batch = FB.db.batch();
    ids.forEach(eid => batch.update(FB.db.doc("tree/edges-" + chunkOf(eid, EDGE_CHUNKS)), {
      [eid]: FV().delete()
    }));
    return batch.commit().catch(() => {});
  };
  const cloudRevision = (text, extra) => {
    if (!cloudLive) return;
    FB.db.collection("revisions").add({
      ts: Date.now(),
      uid: user?.uid || "",
      name: user?.displayName || user?.email || "",
      text,
      ...(extra || {})
    }).catch(() => {});
  };

  // ====================== Auth / access ======================
  const signIn = async () => {
    try {
      await FB.auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch (e) {
      if (e?.code !== "auth/popup-closed-by-user") window.alert("تعذر تسجيل الدخول: " + (e.message || ""));
    }
  };
  const signOut = () => FB.auth.signOut();

  // ====================== Seed / restore the cloud database ======================
  const seedToCloud = async (p, e, ph) => {
    setBusyMsg("جارٍ رفع البيانات إلى السحابة…");
    try {
      const pc = {},
        ec = {},
        phc = {};
      p.forEach(x => {
        (pc[chunkOf(x.id, PEOPLE_CHUNKS)] ||= {})[x.id] = x;
      });
      e.forEach(x => {
        (ec[chunkOf(x.id, EDGE_CHUNKS)] ||= {})[x.id] = x;
      });
      Object.entries(ph || {}).forEach(([id, v]) => {
        (phc[chunkOf(id, PHOTO_CHUNKS)] ||= {})[id] = v;
      });
      const batch = FB.db.batch();
      for (let i = 0; i < PEOPLE_CHUNKS; i++) batch.set(FB.db.doc("tree/people-" + i), pc[i] || {});
      for (let i = 0; i < EDGE_CHUNKS; i++) batch.set(FB.db.doc("tree/edges-" + i), ec[i] || {});
      for (let i = 0; i < PHOTO_CHUNKS; i++) batch.set(FB.db.doc("photos/c" + i), phc[i] || {});
      await batch.commit();
      // meta last: listeners flip to "live" only once all data is in place
      await FB.db.doc("tree/meta").set({
        seeded: true,
        ts: Date.now(),
        version: SEED.version || 2
      });
      FB.db.collection("revisions").add({
        ts: Date.now(),
        uid: user?.uid || "",
        name: user?.displayName || "",
        text: `رفع الشجرة إلى السحابة (${p.length} فرد، ${Object.keys(ph || {}).length} صورة)`
      }).catch(() => {});
    } catch (err) {
      window.alert("فشل الرفع: " + (err.message || ""));
    }
    setBusyMsg("");
  };
  const seedCloudFromCurrent = () => {
    if (!window.confirm(`سيتم رفع ${people.length} فردًا و ${Object.keys(photos).length} صورة إلى قاعدة البيانات السحابية. بعدها تصبح الشجرة مشتركة ومباشرة للجميع. متابعة؟`)) return;
    seedToCloud(people, edges, photos);
  };

  // ====================== Wiki revert ======================
  const revertRevision = async rev => {
    if (!isEditor) return;
    if (!window.confirm(`التراجع عن: ${rev.text}؟`)) return;
    try {
      if (rev.kind === "update" && rev.personId && rev.before) {
        const cur = people.find(p => p.id === rev.personId);
        if (!cur) return window.alert("الشخص لم يعد موجودًا في الشجرة.");
        const restored = {
          ...cur,
          ...rev.before
        };
        setPeople(prev => prev.map(p => p.id === rev.personId ? restored : p));
        await cloudWritePeople([restored]);
      } else if (rev.kind === "add" && rev.personId) {
        const eids = edges.filter(e => e.from === rev.personId || e.to === rev.personId).map(e => e.id);
        setPeople(prev => prev.filter(p => p.id !== rev.personId));
        setEdges(prev => prev.filter(e => e.from !== rev.personId && e.to !== rev.personId));
        await FB.db.doc("tree/people-" + chunkOf(rev.personId, PEOPLE_CHUNKS)).update({
          [rev.personId]: FV().delete()
        });
        await cloudDeleteEdges(eids);
      } else if (rev.kind === "delete" && rev.before?.person) {
        const pr = rev.before.person,
          es = rev.before.edges || [];
        setPeople(prev => [...prev.filter(x => x.id !== pr.id), pr]);
        setEdges(prev => [...prev.filter(e => !es.some(x => x.id === e.id)), ...es]);
        await cloudWritePeople([pr]);
        if (es.length) await cloudWriteEdges(es);
      } else if (rev.kind === "edge-add" && rev.after?.edge) {
        setEdges(prev => prev.filter(e => e.id !== rev.after.edge.id));
        await cloudDeleteEdges([rev.after.edge.id]);
      } else if (rev.kind === "edge-del" && rev.before?.edge) {
        const ed = rev.before.edge;
        setEdges(prev => [...prev.filter(x => x.id !== ed.id), ed]);
        await cloudWriteEdges([ed]);
      } else {
        return window.alert("لا يمكن التراجع عن هذا النوع من التعديلات.");
      }
      cloudRevision(`تراجع عن: ${rev.text}`);
    } catch (e) {
      window.alert("تعذر التراجع: " + (e.message || ""));
    }
  };

  // ====================== Actions ======================
  const centerWorld = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const w = rect ? rect.width : 800,
      h = rect ? rect.height : 600;
    return {
      x: (w / 2 - view.tx) / view.s,
      y: (h / 2 - view.ty) / view.s
    };
  };
  const addPerson = (preset = {}) => {
    const c = centerWorld();
    const np = {
      id: uid(),
      name: preset.name || "جديد",
      x: preset.x ?? c.x,
      y: preset.y ?? c.y,
      note: "",
      deceased: false,
      ...(preset.gender ? {
        gender: preset.gender
      } : {}),
      ...(preset.g != null ? {
        g: preset.g
      } : {})
    };
    setPeople(prev => [...prev, np]);
    setSelectedId(np.id);
    setTab("edit");
    addLog(`إضافة شخص جديد: ${np.name}`);
    cloudWritePeople([np]);
    cloudRevision(`إضافة شخص جديد: ${np.name}`, {
      kind: "add",
      personId: np.id
    });
    return np;
  };

  // text edits flush to the cloud after a short pause, with one history entry per burst
  const dirtyRef = useRef({});
  const updatePerson = (id, patch, logText) => {
    setPeople(prev => prev.map(p => p.id === id ? {
      ...p,
      ...patch
    } : p));
    if (logText) addLog(logText);
    if (!cloudLive) return;
    const cur = people.find(p => p.id === id);
    if (!cur) return;
    const slot = dirtyRef.current[id] ||= {
      before: {
        ...cur
      },
      next: {
        ...cur
      }
    };
    slot.next = {
      ...slot.next,
      ...patch
    };
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      const full = slot.next;
      delete dirtyRef.current[id];
      const keys = Object.keys(full).filter(k => JSON.stringify(full[k]) !== JSON.stringify(slot.before[k]));
      if (!keys.length) return;
      const pick = (o, ks) => ks.reduce((a, k) => (a[k] = o[k] === undefined ? null : o[k], a), {});
      cloudWritePeople([full]);
      cloudRevision(`تعديل بيانات ${full.name}`, {
        kind: "update",
        personId: id,
        before: pick(slot.before, keys),
        after: pick(full, keys)
      });
    }, 1200);
  };
  const deletePerson = id => {
    const p = people.find(x => x.id === id);
    if (!p) return;
    if (!window.confirm(`حذف "${p.name}" وجميع روابطه؟`)) return;
    const removedEdges = edges.filter(e => e.from === id || e.to === id);
    setPeople(prev => prev.filter(x => x.id !== id));
    setEdges(prev => prev.filter(e => e.from !== id && e.to !== id));
    setPhotos(prev => {
      const n = {
        ...prev
      };
      delete n[id];
      return n;
    });
    store.del(photoKey(id));
    if (selectedId === id) setSelectedId(null);
    addLog(`حذف الشخص: ${p.name}`);
    if (cloudLive) {
      FB.db.doc("tree/people-" + chunkOf(id, PEOPLE_CHUNKS)).update({
        [id]: FV().delete()
      }).catch(() => {});
      cloudDeleteEdges(removedEdges.map(e => e.id));
      FB.db.doc("photos/c" + chunkOf(id, PHOTO_CHUNKS)).set({
        [id]: FV().delete()
      }, {
        merge: true
      }).catch(() => {});
      cloudRevision(`حذف الشخص: ${p.name}`, {
        kind: "delete",
        personId: id,
        before: {
          person: p,
          edges: removedEdges
        }
      });
    }
  };
  const addEdge = (from, to, type) => {
    if (from === to) return;
    if (edges.some(e => e.from === from && e.to === to || type === "spouse" && e.type === "spouse" && e.from === to && e.to === from)) return;
    const edge = {
      id: uid(),
      from,
      to,
      ...(type && type !== "parent" ? {
        type
      } : {})
    };
    setEdges(prev => [...prev, edge]);
    const a = people.find(p => p.id === from)?.name || "";
    const b = people.find(p => p.id === to)?.name || "";
    const txt = type === "spouse" ? `إضافة رابط زواج: ${a} ↔ ${b}` : `إضافة رابط: ${a} ← ${b}`;
    addLog(txt);
    cloudWriteEdges([edge]);
    cloudRevision(txt, {
      kind: "edge-add",
      after: {
        edge
      }
    });
  };
  const removeEdge = eid => {
    const e = edges.find(x => x.id === eid);
    if (!e) return;
    setEdges(prev => prev.filter(x => x.id !== eid));
    const a = people.find(p => p.id === e.from)?.name || "";
    const b = people.find(p => p.id === e.to)?.name || "";
    addLog(`حذف رابط: ${a} ← ${b}`);
    cloudDeleteEdges([eid]);
    cloudRevision(`حذف رابط: ${a} ← ${b}`, {
      kind: "edge-del",
      before: {
        edge: e
      }
    });
  };

  // find a horizontal slot at row y0 that doesn't overlap an existing card
  const freeX = (x0, y0) => {
    const row = people.filter(p => Math.abs(p.y - y0) < 80);
    let x = x0,
      guard = 0;
    while (row.some(p => Math.abs(p.x - x) < NODE_W + 20) && guard++ < 300) x += NODE_W + 30;
    return x;
  };
  const addChild = (parentId, gender = "m") => {
    const parent = people.find(p => p.id === parentId);
    if (!parent) return;
    const sibs = edges.filter(e => e.type !== "spouse" && e.from === parentId).map(e => people.find(p => p.id === e.to)).filter(Boolean);
    const cy = parent.y + 250;
    const child = addPerson({
      x: freeX(sibs.length ? Math.max(...sibs.map(sb => sb.x)) + NODE_W + 30 : parent.x, cy),
      y: cy,
      name: gender === "f" ? "بنت" : "ابن",
      gender,
      g: parent.g != null ? parent.g + 1 : undefined
    });
    const edge = {
      id: uid(),
      from: parentId,
      to: child.id
    };
    setEdges(prev => [...prev, edge]);
    addLog(`ربط ${gender === "f" ? "بنت جديدة" : "ابن جديد"} بـ ${parent.name}`);
    cloudWriteEdges([edge]);
    cloudRevision(`ربط ${gender === "f" ? "بنت جديدة" : "ابن جديد"} بـ ${parent.name}`, {
      kind: "edge-add",
      after: {
        edge
      }
    });
  };
  const addParent = (childId, gender = "m") => {
    const child = people.find(p => p.id === childId);
    if (!child) return;
    const parent = addPerson({
      x: freeX(child.x - 30, child.y - 250),
      y: child.y - 250,
      name: gender === "f" ? "والدة" : "والد",
      gender,
      g: child.g != null ? child.g - 1 : undefined
    });
    const edge = {
      id: uid(),
      from: parent.id,
      to: childId
    };
    setEdges(prev => [...prev, edge]);
    addLog(`ربط ${gender === "f" ? "والدة" : "والد"} بـ ${child.name}`);
    cloudWriteEdges([edge]);
    cloudRevision(`ربط ${gender === "f" ? "والدة" : "والد"} بـ ${child.name}`, {
      kind: "edge-add",
      after: {
        edge
      }
    });
  };
  const addSpouse = personId => {
    const p0 = people.find(p => p.id === personId);
    if (!p0) return;
    const gender = p0.gender === "f" ? "m" : "f";
    const sp = addPerson({
      x: freeX(p0.x + NODE_W + 40, p0.y),
      y: p0.y,
      name: gender === "f" ? "زوجة" : "زوج",
      gender,
      g: p0.g
    });
    const edge = {
      id: uid(),
      from: personId,
      to: sp.id,
      type: "spouse"
    };
    setEdges(prev => [...prev, edge]);
    addLog(`ربط ${gender === "f" ? "زوجة" : "زوج"} بـ ${p0.name}`);
    cloudWriteEdges([edge]);
    cloudRevision(`ربط ${gender === "f" ? "زوجة" : "زوج"} بـ ${p0.name}`, {
      kind: "edge-add",
      after: {
        edge
      }
    });
  };
  const handlePhoto = async (id, file) => {
    if (!file) return;
    try {
      const data = await resizeImage(file);
      setPhotos(prev => ({
        ...prev,
        [id]: data
      }));
      const nm = people.find(p => p.id === id)?.name || "";
      if (cloudLive) {
        await FB.db.doc("photos/c" + chunkOf(id, PHOTO_CHUNKS)).set({
          [id]: data
        }, {
          merge: true
        });
        cloudRevision(`رفع صورة لـ ${nm}`, {
          kind: "photo",
          personId: id
        });
      } else {
        await store.set(photoKey(id), data);
      }
      addLog(`رفع صورة لـ ${nm}`);
    } catch {
      window.alert("تعذر تحميل الصورة");
    }
  };
  const removePhoto = id => {
    setPhotos(prev => {
      const n = {
        ...prev
      };
      delete n[id];
      return n;
    });
    const nm = people.find(p => p.id === id)?.name || "";
    if (cloudLive) {
      FB.db.doc("photos/c" + chunkOf(id, PHOTO_CHUNKS)).set({
        [id]: FV().delete()
      }, {
        merge: true
      }).catch(() => {});
      cloudRevision(`حذف صورة: ${nm}`, {
        kind: "photo",
        personId: id
      });
    } else {
      store.del(photoKey(id));
    }
    addLog(`حذف صورة: ${nm}`);
  };
  const onNodeClick = id => {
    if (linkMode) {
      if (!linkFrom) {
        setLinkFrom(id);
      } else {
        addEdge(linkFrom, id);
        setLinkFrom(null);
        setLinkMode(false);
      }
      return;
    }
    setSelectedId(id);
    setTab("view");
    setShowPanel(true);
  };

  // ====================== Pointer: drag node / pan ======================
  const onNodePointerDown = (e, id) => {
    // nodes are locked to their generation tier; only the canvas pans
  };
  const ptrs = useRef(new Map());
  const pinchRef = useRef(null);
  const onCanvasPointerDown = e => {
    ptrs.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY
    });
    if (ptrs.current.size === 1) {
      panRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        tx: view.tx,
        ty: view.ty
      };
    } else if (ptrs.current.size === 2) {
      panRef.current = null;
      const [a, b] = [...ptrs.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = canvasRef.current.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - rect.left,
        my = (a.y + b.y) / 2 - rect.top;
      pinchRef.current = {
        dist,
        s: view.s,
        tx: view.tx,
        ty: view.ty,
        mx,
        my,
        wx: (mx - view.tx) / view.s,
        wy: (my - view.ty) / view.s
      };
    }
  };
  const onPointerMove = e => {
    if (ptrs.current.has(e.pointerId)) ptrs.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY
    });
    if (ptrs.current.size >= 2 && pinchRef.current) {
      const [a, b] = [...ptrs.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const pr = pinchRef.current;
      const ns = Math.min(3, Math.max(0.12, pr.s * (dist / pr.dist)));
      setView({
        s: ns,
        tx: pr.mx - pr.wx * ns,
        ty: pr.my - pr.wy * ns
      });
      return;
    }
    if (panRef.current) {
      const p = panRef.current;
      setView(v => ({
        ...v,
        tx: p.tx + (e.clientX - p.startX),
        ty: p.ty + (e.clientY - p.startY)
      }));
    }
  };
  const onPointerUp = e => {
    if (e && e.pointerId !== undefined) ptrs.current.delete(e.pointerId);
    if (ptrs.current.size < 2) pinchRef.current = null;
    if (ptrs.current.size === 0) panRef.current = null;
  };
  const onWheel = e => {
    e.preventDefault();
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left,
      my = e.clientY - rect.top;
    const wx = (mx - view.tx) / view.s,
      wy = (my - view.ty) / view.s;
    const ns = Math.min(3, Math.max(0.12, view.s * (e.deltaY < 0 ? 1.1 : 0.9)));
    setView({
      s: ns,
      tx: mx - wx * ns,
      ty: my - wy * ns
    });
  };
  const zoom = f => {
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = rect.width / 2,
      my = rect.height / 2;
    const wx = (mx - view.tx) / view.s,
      wy = (my - view.ty) / view.s;
    const ns = Math.min(3, Math.max(0.12, view.s * f));
    setView({
      s: ns,
      tx: mx - wx * ns,
      ty: my - wy * ns
    });
  };

  // ====================== Backup ======================
  const exportData = () => {
    const blob = new Blob([JSON.stringify({
      people,
      edges,
      photos,
      log
    }, null, 2)], {
      type: "application/json"
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `family-tree-${Date.now()}.json`;
    a.click();
    addLog("تصدير نسخة احتياطية");
  };
  const importData = async file => {
    if (!file) return;
    try {
      const txt = await file.text();
      const d = JSON.parse(txt);
      if (cloudLive) {
        // full restore of the shared database (admin only — enforced by rules too)
        if (!isAdmin) return window.alert("الاستعادة إلى قاعدة البيانات المشتركة متاحة للمشرف فقط.");
        if (!window.confirm("سيتم استبدال الشجرة المشتركة بالكامل بمحتوى هذا الملف، للجميع. متابعة؟")) return;
        await seedToCloud(d.people || [], d.edges || [], d.photos || {});
        return;
      }
      setPeople(d.people || []);
      setEdges(d.edges || []);
      setPhotos(d.photos || {});
      await store.set(TREE_KEY, JSON.stringify({
        people: d.people || [],
        edges: d.edges || []
      }));
      for (const [id, data] of Object.entries(d.photos || {})) await store.set(photoKey(id), data);
      addLog("استيراد نسخة احتياطية");
    } catch {
      window.alert("ملف غير صالح");
    }
  };

  // ====================== Render ======================
  const pmap = {};
  for (const _p of people) pmap[_p.id] = _p;

  // outside family mode the female layer is hidden entirely
  const visPeople = familyMode ? people : people.filter(p => p.gender !== "f");
  const visIds = new Set(visPeople.map(p => p.id));
  const visEdges = edges.filter(e => visIds.has(e.from) && visIds.has(e.to));
  const selected = visPeople.find(p => p.id === selectedId);
  const q = normAr(search);
  const searchHits = q ? visPeople.filter(p => normAr(p.name).includes(q) || normAr(p.nickname).includes(q)) : [];

  // virtualization: only nodes/connectors near the viewport are rendered
  const cRect = canvasRef.current?.getBoundingClientRect();
  const vw = cRect ? cRect.width : 1200,
    vh = cRect ? cRect.height : 800;
  const MARGIN = 600;
  const wx0 = -view.tx / view.s - MARGIN,
    wx1 = (vw - view.tx) / view.s + MARGIN;
  const wy0 = -view.ty / view.s - MARGIN,
    wy1 = (vh - view.ty) / view.s + MARGIN;
  const inWorld = (x, y) => x >= wx0 && x <= wx1 && y >= wy0 && y <= wy1;
  const drawnPeople = visPeople.filter(p => inWorld(p.x, p.y));

  // ---------- shared genealogy structures for the alternative views ----------
  // primary parent = father when both parents are linked, so each child appears once
  const childMap = {},
    primParent = {};
  {
    const parentsByChild = {};
    visEdges.filter(e => e.type !== "spouse").forEach(e => (parentsByChild[e.to] ||= []).push(e.from));
    for (const c in parentsByChild) {
      if (!visIds.has(c)) continue;
      const ps = parentsByChild[c].filter(id => visIds.has(id));
      if (!ps.length) continue;
      const father = ps.find(id => pmap[id]?.gender !== "f") || ps[0];
      primParent[c] = father;
      (childMap[father] ||= []).push(c);
    }
    for (const k in childMap) childMap[k].sort((a, b) => (pmap[a]?.x || 0) - (pmap[b]?.x || 0));
  }
  const kidsOf = id => childMap[id] || [];
  const spousesOf = id => visEdges.filter(e => e.type === "spouse" && (e.from === id || e.to === id)).map(e => e.from === id ? e.to : e.from).filter(x => visIds.has(x));
  const otherParentsOf = id => visEdges.filter(e => e.type !== "spouse" && e.to === id && e.from !== primParent[id]).map(e => e.from).filter(x => visIds.has(x));
  const descCount = id => kidsOf(id).reduce((a, c) => a + 1 + descCount(c), 0);
  const isSpouseOnly = p => !primParent[p.id] && !kidsOf(p.id).length && spousesOf(p.id).length > 0;
  const treeRoots = visPeople.filter(p => !primParent[p.id] && !isSpouseOnly(p)).sort((a, b) => descCount(b.id) - descCount(a.id));
  const mainRoot = treeRoots[0]?.id || null;
  const depthOf = id => {
    let d = 0,
      c = id;
    while (primParent[c] && d < 20) {
      c = primParent[c];
      d++;
    }
    return d;
  };

  // tidy layout for the collapsible tree (leaf counting, spans all roots)
  const TREE_DX = 118,
    TREE_DY = 168;
  const tidyLayout = collapsedSet => {
    const pos = {};
    let cursor = 0;
    const walk = (id, depth) => {
      const kids = collapsedSet.has(id) ? [] : kidsOf(id);
      if (!kids.length) {
        pos[id] = {
          x: cursor++ * TREE_DX,
          y: depth * TREE_DY
        };
        return pos[id].x;
      }
      const xs = kids.map(k => walk(k, depth + 1));
      pos[id] = {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: depth * TREE_DY
      };
      return pos[id].x;
    };
    treeRoots.forEach(r => {
      walk(r.id, 0);
      cursor += 1.5;
    });
    return pos;
  };
  const treePos = viewMode === "tree" && treeCollapsed ? tidyLayout(treeCollapsed) : null;
  treePosRef.current = treePos || treePosRef.current;
  mainRootRef.current = mainRoot;
  const lineageStr = id => {
    const parts = [];
    let c = id,
      n = 0;
    while (primParent[c] && n++ < 4) {
      c = primParent[c];
      if (pmap[c]) parts.push(pmap[c].name);
    }
    return parts.length ? `${pmap[id]?.gender === "f" ? "بنت" : "بن"} ${parts.join(" بن ")}` : "";
  };

  // hourglass layout around focusId
  const hgFocus = viewMode === "focus" ? focusId && visIds.has(focusId) ? focusId : selectedId && visIds.has(selectedId) ? selectedId : mainRoot : null;
  let hgPos = null,
    hgLinks = null,
    hgSpouses = null,
    hgMothers = null;
  if (viewMode === "focus" && hgFocus) {
    hgPos = {};
    hgLinks = [];
    hgSpouses = [];
    hgMothers = [];
    let cur = hgFocus,
      d = 0;
    while (primParent[cur] && d < 15) {
      const f = primParent[cur];
      d++;
      hgPos[f] = {
        x: 0,
        y: -d * TREE_DY
      };
      hgLinks.push({
        from: f,
        to: cur
      });
      otherParentsOf(cur).forEach((m, i) => {
        hgPos[m] = {
          x: -(i + 1) * 150,
          y: -d * TREE_DY
        };
        hgMothers.push(m);
      });
      cur = f;
    }
    let cursor = 0;
    const walk = (id, depth) => {
      const kids = kidsOf(id);
      if (!kids.length) {
        hgPos[id] = {
          x: cursor++ * TREE_DX,
          y: depth * TREE_DY
        };
        return hgPos[id].x;
      }
      const xs = kids.map(k => {
        const r = walk(k, depth + 1);
        hgLinks.push({
          from: id,
          to: k
        });
        return r;
      });
      hgPos[id] = {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: depth * TREE_DY
      };
      return hgPos[id].x;
    };
    walk(hgFocus, 0);
    const off = hgPos[hgFocus].x;
    for (const id in hgPos) if (hgPos[id].y >= 0) hgPos[id].x -= off;
    spousesOf(hgFocus).forEach((sp, i) => {
      hgPos[sp] = {
        x: 150 + i * 130,
        y: 0
      };
      hgSpouses.push(sp);
    });
  }
  const C = {
    bg: "#f6f4ee",
    panel: "#ffffff",
    panel2: "#f1ede4",
    gold: "#2f7d62",
    goldSoft: "#3f8f73",
    parch: "#2b2a25",
    sub: "#7b7568",
    line: "#9fb6ab",
    border: "#e4dfd4"
  };
  const focusPerson = p => {
    setSelectedId(p.id);
    setSearch("");
    setTab("view");
    setShowPanel(true);
    if (viewMode === "classic") {
      const rect = canvasRef.current.getBoundingClientRect();
      setView({
        s: 1,
        tx: rect.width / 2 - p.x,
        ty: rect.height / 2 - p.y
      });
    } else if (viewMode === "focus") {
      setFocusId(p.id);
    }
    // tree & list modes: the reveal effect expands ancestors and centers/scrolls
  };
  return /*#__PURE__*/React.createElement("div", {
    dir: "rtl",
    style: {
      fontFamily: "'Tajawal', sans-serif",
      background: C.bg,
      color: C.parch,
      width: "100%",
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 18px",
      borderBottom: `1px solid ${C.border}`,
      background: "#ffffff",
      flexShrink: 0,
      zIndex: 30
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "7px 13px",
      borderRadius: 8,
      display: "grid",
      placeItems: "center",
      background: C.gold,
      color: "#ffffff",
      fontWeight: 700,
      fontSize: 17,
      fontFamily: "'Amiri', serif",
      whiteSpace: "nowrap",
      lineHeight: 1
    }
  }, "آل وزرة"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Amiri', serif",
      fontSize: 22,
      fontWeight: 700,
      color: C.gold,
      lineHeight: 1.1
    }
  }, "شجرة العائلة"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub
    }
  }, visPeople.length, " فرد · ", visEdges.length, " رابط", cloudLive ? " · ☁ مباشر" : ""))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, FB && cloud !== "off" && (user ? /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: signOut,
    title: user.email
  }, (user.displayName || user.email || "").split(" ")[0], " · خروج") : /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: signIn
  }, "تسجيل الدخول")), /*#__PURE__*/React.createElement(Btn, {
    C: C,
    active: familyMode,
    onClick: () => familyMode ? lockFamily() : setShowUnlock(true)
  }, familyMode ? "🔓 الوضع العائلي" : "🔒 الوضع العائلي"), canEdit && /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: () => addPerson()
  }, "+ شخص"), canEdit && /*#__PURE__*/React.createElement(Btn, {
    C: C,
    active: linkMode,
    onClick: () => {
      setLinkMode(m => !m);
      setLinkFrom(null);
    }
  }, linkMode ? linkFrom ? "اختر الثاني…" : "اختر الأول…" : "ربط شخصين"), /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: () => setShowPanel(s => !s)
  }, showPanel ? "إخفاء اللوحة" : "إظهار اللوحة"), /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: () => setShowStats(true)
  }, "📊 إحصائيات"), /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: () => setShowGallery(true)
  }, "🖼️ معرض"), /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: exportData
  }, "تصدير"), (!cloudLive || isAdmin) && /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: () => importRef.current?.click()
  }, "استيراد"), /*#__PURE__*/React.createElement("input", {
    ref: importRef,
    type: "file",
    accept: "application/json",
    style: {
      display: "none"
    },
    onChange: e => {
      importData(e.target.files[0]);
      e.target.value = "";
    }
  }))), cloud === "empty" && isAdmin && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      flexWrap: "wrap",
      padding: "8px 14px",
      background: "#e8f2ee",
      borderBottom: "1px solid #bcd8cd",
      fontSize: 13,
      color: "#1f5c46",
      flexShrink: 0,
      zIndex: 29
    }
  }, "قاعدة البيانات السحابية جاهزة لكنها فارغة — ارفع الشجرة الحالية لتصبح مشتركة ومباشرة للجميع.", /*#__PURE__*/React.createElement("button", {
    onClick: seedCloudFromCurrent,
    disabled: !photosReady || !!busyMsg,
    style: {
      background: photosReady && !busyMsg ? C.gold : "#9db3aa",
      color: "#fff",
      border: "none",
      padding: "5px 14px",
      borderRadius: 6,
      cursor: photosReady && !busyMsg ? "pointer" : "wait",
      fontFamily: "'Tajawal'",
      fontSize: 13,
      fontWeight: 600
    }
  }, busyMsg || (photosReady ? "رفع البيانات إلى السحابة" : "بانتظار تحميل الصور…"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      padding: "7px 12px",
      borderBottom: `1px solid ${C.border}`,
      background: C.panel,
      overflowX: "auto",
      flexShrink: 0,
      zIndex: 28
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      alignSelf: "center",
      fontSize: 12.5,
      color: C.sub,
      fontWeight: 700,
      flexShrink: 0,
      marginLeft: 2
    }
  }, "العرض:"), [["tree", "🌳 الشجرة"], ["list", "📋 القائمة"], ["focus", "👤 المحور"], ["classic", "🗺️ الكلاسيكي"]].map(([k, l]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setViewMode(k),
    style: {
      padding: "6px 14px",
      borderRadius: 16,
      whiteSpace: "nowrap",
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 13,
      fontWeight: 700,
      flexShrink: 0,
      border: `1px solid ${viewMode === k ? C.gold : C.border}`,
      background: viewMode === k ? C.gold : "transparent",
      color: viewMode === k ? "#fff" : C.sub
    }
  }, l))), updateAvail && !cloudLive && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: "8px 14px",
      background: "#fdf3dd",
      borderBottom: "1px solid #ecd9ac",
      fontSize: 13,
      color: "#7a5b16",
      flexShrink: 0,
      zIndex: 29
    }
  }, "صدرت نسخة رسمية أحدث من الشجرة.", /*#__PURE__*/React.createElement("button", {
    onClick: applySeedUpdate,
    style: {
      background: C.gold,
      color: "#fff",
      border: "none",
      padding: "5px 14px",
      borderRadius: 6,
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 13,
      fontWeight: 600
    }
  }, "تحديث الآن"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setUpdateAvail(false),
    style: {
      background: "transparent",
      color: "#7a5b16",
      border: "none",
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 13,
      textDecoration: "underline"
    }
  }, "لاحقًا")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: "flex",
      overflow: "hidden",
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    ref: canvasRef,
    onPointerDown: viewMode === "list" ? undefined : onCanvasPointerDown,
    onPointerMove: viewMode === "list" ? undefined : onPointerMove,
    onPointerUp: viewMode === "list" ? undefined : onPointerUp,
    onPointerLeave: viewMode === "list" ? undefined : onPointerUp,
    onWheel: viewMode === "list" ? undefined : onWheel,
    style: {
      flex: 1,
      position: "relative",
      overflow: "hidden",
      cursor: viewMode === "list" ? "default" : "grab",
      backgroundImage: "radial-gradient(circle at 20% 30%, #eaf2ee 0, transparent 55%), radial-gradient(circle at 80% 70%, #f0ece2 0, transparent 55%)",
      backgroundColor: C.bg,
      touchAction: viewMode === "list" ? "auto" : "none"
    }
  }, viewMode !== "list" && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 0,
      left: 0,
      transform: `translate(${view.tx}px,${view.ty}px) scale(${view.s})`,
      transformOrigin: "0 0"
    }
  }, viewMode === "classic" && /*#__PURE__*/React.createElement(React.Fragment, null, (() => {
    if (!visPeople.length) return null;
    const byId = pmap;
    const xs = visPeople.map(p => p.x);
    const minX = Math.min(...xs) - 240,
      maxX = Math.max(...xs) + 240;
    const maxG = visPeople.reduce((m, p) => Math.max(m, p.g || 0), 0);
    const ord = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
    const bands = [];
    for (let g = 0; g <= maxG; g++) {
      const cy = 140 + g * 250;
      bands.push(/*#__PURE__*/React.createElement("div", {
        key: "band" + g,
        style: {
          position: "absolute",
          left: minX,
          top: cy - NODE_H / 2 - 26,
          width: maxX - minX,
          height: NODE_H + 52,
          background: g % 2 ? "rgba(47,125,98,.055)" : "rgba(47,125,98,.02)",
          borderTop: "1px solid rgba(47,125,98,.18)",
          borderBottom: "1px solid rgba(47,125,98,.18)"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          position: "sticky",
          left: 12,
          top: 0,
          display: "inline-block",
          marginTop: 6,
          padding: "3px 12px",
          background: C.gold,
          color: "#fff",
          borderRadius: 6,
          fontFamily: "'Amiri',serif",
          fontSize: 18,
          whiteSpace: "nowrap"
        }
      }, "الجيل ", ord[g] || g + 1)));
    }
    return bands;
  })(), /*#__PURE__*/React.createElement("svg", {
    style: {
      position: "absolute",
      overflow: "visible",
      width: 1,
      height: 1,
      pointerEvents: "none"
    }
  }, (() => {
    const byId = pmap;
    const kids = {};
    visEdges.filter(e => e.type !== "spouse").forEach(e => {
      (kids[e.from] = kids[e.from] || []).push(e.to);
    });
    const out = [];
    // marriage links: double horizontal line between spouses in the same tier
    visEdges.filter(e => e.type === "spouse").forEach(e => {
      const a = byId[e.from],
        b = byId[e.to];
      if (!a || !b) return;
      if (!inWorld(a.x, a.y) && !inWorld(b.x, b.y)) return;
      const [l, r] = a.x <= b.x ? [a, b] : [b, a];
      let x1 = l.x + NODE_W / 2,
        x2 = r.x - NODE_W / 2;
      if (x2 <= x1) {
        x1 = l.x;
        x2 = r.x;
      }
      const y = (a.y + b.y) / 2;
      out.push(/*#__PURE__*/React.createElement("line", {
        key: e.id + "s1",
        x1: x1,
        y1: y - 3,
        x2: x2,
        y2: y - 3,
        stroke: "#c98aa0",
        strokeWidth: 1.5
      }));
      out.push(/*#__PURE__*/React.createElement("line", {
        key: e.id + "s2",
        x1: x1,
        y1: y + 3,
        x2: x2,
        y2: y + 3,
        stroke: "#c98aa0",
        strokeWidth: 1.5
      }));
    });
    Object.keys(kids).forEach(pid => {
      const par = byId[pid];
      if (!par) return;
      const cs = kids[pid].map(id => byId[id]).filter(Boolean);
      if (!cs.length) return;
      // cull connector groups fully outside the viewport
      const gx0 = Math.min(par.x, ...cs.map(c => c.x)),
        gx1 = Math.max(par.x, ...cs.map(c => c.x));
      const gy0 = Math.min(par.y, ...cs.map(c => c.y)),
        gy1 = Math.max(par.y, ...cs.map(c => c.y));
      if (gx1 < wx0 || gx0 > wx1 || gy1 < wy0 || gy0 > wy1) return;
      const pBot = par.y + NODE_H / 2;
      const cTop = cs[0].y - NODE_H / 2;
      const busY = pBot + (cTop - pBot) * 0.5;
      const xsC = cs.map(c => c.x);
      const loX = Math.min(par.x, ...xsC),
        hiX = Math.max(par.x, ...xsC);
      out.push(/*#__PURE__*/React.createElement("line", {
        key: pid + "p",
        x1: par.x,
        y1: pBot,
        x2: par.x,
        y2: busY,
        stroke: C.line,
        strokeWidth: 1.5
      }));
      if (cs.length > 1) out.push(/*#__PURE__*/React.createElement("line", {
        key: pid + "h",
        x1: loX,
        y1: busY,
        x2: hiX,
        y2: busY,
        stroke: C.line,
        strokeWidth: 1.5
      }));
      cs.forEach(c => out.push(/*#__PURE__*/React.createElement("line", {
        key: pid + c.id,
        x1: c.x,
        y1: busY,
        x2: c.x,
        y2: c.y - NODE_H / 2,
        stroke: C.line,
        strokeWidth: 1.5
      })));
    });
    return out;
  })()), drawnPeople.map(p => {
    const isSel = p.id === selectedId;
    const isLinkFrom = linkFrom === p.id;
    const isF = p.gender === "f";
    const accent = isF ? "#b06a84" : C.goldSoft;
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      onPointerDown: e => onNodePointerDown(e, p.id),
      onClick: e => {
        e.stopPropagation();
        if (!dragRef.current?.moved) onNodeClick(p.id);
      },
      style: {
        position: "absolute",
        left: p.x,
        top: p.y,
        width: NODE_W,
        height: NODE_H,
        marginLeft: -NODE_W / 2,
        marginTop: -NODE_H / 2,
        background: isF ? "linear-gradient(180deg,#ffffff,#f7eef2)" : "linear-gradient(180deg,#ffffff,#f5f2ea)",
        borderRadius: 12,
        padding: 10,
        boxSizing: "border-box",
        border: `2px solid ${isLinkFrom ? "#e0a23a" : isSel ? C.gold : isF ? "#e0c4cf" : "#ddd7c9"}`,
        boxShadow: isSel ? `0 0 0 4px rgba(47,125,98,.22), 0 8px 22px rgba(0,0,0,.16)` : "0 3px 10px rgba(0,0,0,.10)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        cursor: "pointer",
        userSelect: "none"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 74,
        height: 74,
        borderRadius: "50%",
        overflow: "hidden",
        border: `2px solid ${accent}`,
        background: "#e9e4d8",
        display: "grid",
        placeItems: "center",
        flexShrink: 0
      }
    }, photos[p.id] ? /*#__PURE__*/React.createElement("img", {
      src: photos[p.id],
      alt: "",
      style: {
        width: "100%",
        height: "100%",
        objectFit: "cover"
      }
    }) : /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "'Amiri',serif",
        fontSize: 26,
        color: "#8c857a"
      }
    }, p.name?.trim()?.[0] || "؟")), p.deceased && /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        top: 5,
        left: 5,
        background: "rgba(122,106,71,.13)",
        color: "#7a6a47",
        fontSize: 9,
        padding: "2px 7px",
        borderRadius: 7,
        fontFamily: "'Tajawal'",
        fontWeight: 500,
        whiteSpace: "nowrap"
      }
    }, mercy(p)), /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Amiri', serif",
        fontWeight: 700,
        fontSize: 14.5,
        color: "#2c2415",
        marginTop: 5,
        textAlign: "center",
        lineHeight: 1.3,
        maxWidth: "100%",
        overflow: "hidden",
        display: "-webkit-box",
        WebkitLineClamp: p.nickname ? 1 : 2,
        WebkitBoxOrient: "vertical"
      }
    }, p.name), p.nickname && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "#8a7d6a",
        textAlign: "center",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      }
    }, p.nickname), p.note && !p.deceased && !p.nickname && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "#6b5d40",
        marginTop: 2,
        textAlign: "center",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth: "100%"
      }
    }, p.note));
  })), viewMode === "tree" && treePos && (() => {
    const entries = Object.entries(treePos);
    const paths = [];
    for (const [id, q] of entries) {
      if (treeCollapsed.has(id)) continue;
      for (const k of kidsOf(id)) {
        const kq = treePos[k];
        if (!kq) continue;
        const gx0 = Math.min(q.x, kq.x),
          gx1 = Math.max(q.x, kq.x);
        if (gx1 < wx0 || gx0 > wx1 || kq.y < wy0 || q.y > wy1) continue;
        const midY = (q.y + 32 + kq.y - 34) / 2;
        paths.push(/*#__PURE__*/React.createElement("path", {
          key: id + "-" + k,
          d: `M${q.x},${q.y + 30} V${midY} H${kq.x} V${kq.y - 32}`,
          fill: "none",
          stroke: C.line,
          strokeWidth: 1.5
        }));
      }
    }
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("svg", {
      style: {
        position: "absolute",
        overflow: "visible",
        width: 1,
        height: 1,
        pointerEvents: "none"
      }
    }, paths), entries.filter(([, q]) => inWorld(q.x, q.y)).map(([id, q]) => {
      const p = pmap[id];
      if (!p) return null;
      const kn = kidsOf(id).length;
      const col = treeCollapsed.has(id);
      return /*#__PURE__*/React.createElement(React.Fragment, {
        key: id
      }, /*#__PURE__*/React.createElement(MiniNode, {
        C: C,
        p: p,
        x: q.x,
        y: q.y,
        photo: photos[id],
        selected: id === selectedId,
        onTap: pid => onNodeClick(pid)
      }), spousesOf(id).map((sp, i) => /*#__PURE__*/React.createElement("div", {
        key: sp,
        onClick: e => {
          e.stopPropagation();
          onNodeClick(sp);
        },
        title: pmap[sp]?.name || "",
        style: {
          position: "absolute",
          left: q.x + 30,
          top: q.y - 38 - i * 26,
          width: 30,
          height: 30,
          borderRadius: "50%",
          overflow: "hidden",
          border: `2px ${pmap[sp]?.deceased ? "dashed" : "solid"} #b06a84`,
          background: "#f4e9ee",
          display: "grid",
          placeItems: "center",
          cursor: "pointer",
          zIndex: 2,
          boxShadow: "0 1px 4px rgba(0,0,0,.15)"
        }
      }, photos[sp] ? /*#__PURE__*/React.createElement("img", {
        src: photos[sp],
        alt: "",
        style: {
          width: "100%",
          height: "100%",
          objectFit: "cover"
        }
      }) : /*#__PURE__*/React.createElement("span", {
        style: {
          fontFamily: "'Amiri',serif",
          fontSize: 13,
          color: "#8c5a70"
        }
      }, pmap[sp]?.name?.[0] || "؟"))), kn > 0 && /*#__PURE__*/React.createElement("div", {
        onClick: e => {
          e.stopPropagation();
          const ns = new Set(treeCollapsed);
          col ? ns.delete(id) : ns.add(id);
          // keep the tapped node visually anchored: the whole tree re-lays-out
          // on expand/collapse, so compensate the pan for this node's x shift
          const np = tidyLayout(ns);
          const dx = (np[id]?.x ?? q.x) - q.x;
          setTreeCollapsed(ns);
          if (dx) setView(v => ({
            ...v,
            tx: v.tx - dx * v.s
          }));
        },
        style: {
          position: "absolute",
          left: q.x,
          top: q.y + 64,
          transform: "translate(-50%,0)",
          minWidth: 28,
          height: 24,
          padding: "0 8px",
          borderRadius: 12,
          background: col ? C.gold : C.panel,
          color: col ? "#fff" : C.sub,
          border: `1px solid ${col ? C.gold : C.border}`,
          fontSize: 11.5,
          fontWeight: 700,
          display: "grid",
          placeItems: "center",
          cursor: "pointer",
          fontFamily: "'Tajawal'",
          zIndex: 2,
          whiteSpace: "nowrap"
        }
      }, col ? `⊕ ${descCount(id)}` : "−"));
    }));
  })(), viewMode === "focus" && hgPos && (() => {
    const paths = hgLinks.map((l, i) => {
      const a = hgPos[l.from],
        b = hgPos[l.to];
      if (!a || !b) return null;
      const midY = (a.y + 32 + b.y - 34) / 2;
      return /*#__PURE__*/React.createElement("path", {
        key: i,
        d: `M${a.x},${a.y + 30} V${midY} H${b.x} V${b.y - 32}`,
        fill: "none",
        stroke: l.from === primParent[hgFocus] || l.to === hgFocus ? C.gold : C.line,
        strokeWidth: l.to === hgFocus ? 2.4 : 1.5
      });
    });
    hgSpouses.forEach((sp, i) => {
      const b = hgPos[sp];
      paths.push(/*#__PURE__*/React.createElement("line", {
        key: "s1" + i,
        x1: 46,
        y1: -4,
        x2: b.x - 32,
        y2: -4,
        stroke: "#c98aa0",
        strokeWidth: 1.5
      }));
      paths.push(/*#__PURE__*/React.createElement("line", {
        key: "s2" + i,
        x1: 46,
        y1: 4,
        x2: b.x - 32,
        y2: 4,
        stroke: "#c98aa0",
        strokeWidth: 1.5
      }));
    });
    hgMothers.forEach((m, i) => {
      const a = hgPos[m];
      paths.push(/*#__PURE__*/React.createElement("line", {
        key: "m" + i,
        x1: a.x + 32,
        y1: a.y,
        x2: -4,
        y2: a.y,
        stroke: "#c98aa0",
        strokeWidth: 1.2,
        strokeDasharray: "4 3"
      }));
    });
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("svg", {
      style: {
        position: "absolute",
        overflow: "visible",
        width: 1,
        height: 1,
        pointerEvents: "none"
      }
    }, paths), Object.entries(hgPos).filter(([, q]) => inWorld(q.x, q.y)).map(([id, q]) => /*#__PURE__*/React.createElement(MiniNode, {
      key: id,
      C: C,
      p: pmap[id],
      x: q.x,
      y: q.y,
      photo: photos[id],
      selected: id === selectedId,
      focusCard: id === hgFocus,
      onTap: pid => {
        if (linkMode) return onNodeClick(pid);
        setFocusId(pid);
        setSelectedId(pid);
      }
    })), /*#__PURE__*/React.createElement("div", {
      onClick: () => {
        setSelectedId(hgFocus);
        setTab("view");
        setShowPanel(true);
      },
      style: {
        position: "absolute",
        left: 0,
        top: 96,
        transform: "translate(-50%,0)",
        background: C.gold,
        color: "#fff",
        borderRadius: 14,
        padding: "5px 16px",
        fontSize: 12.5,
        fontWeight: 700,
        fontFamily: "'Tajawal'",
        cursor: "pointer",
        whiteSpace: "nowrap",
        zIndex: 2
      }
    }, "عرض الملف"));
  })()), viewMode === "list" && listOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      overflowY: "auto",
      padding: "10px 10px 90px",
      WebkitOverflowScrolling: "touch"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 640,
      margin: "0 auto"
    }
  }, (() => {
    const out = [];
    const emit = (id, depth) => {
      const p = pmap[id];
      if (!p || !visIds.has(id)) return;
      const kids = kidsOf(id);
      const open = listOpen.has(id);
      out.push(/*#__PURE__*/React.createElement("div", {
        key: id,
        id: "lrow-" + id,
        style: {
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 2px",
          marginRight: Math.min(depth, 7) * 16,
          borderRadius: 8,
          background: id === selectedId ? "rgba(47,125,98,.10)" : "transparent"
        }
      }, /*#__PURE__*/React.createElement("div", {
        onClick: () => {
          if (!kids.length) return;
          const ns = new Set(listOpen);
          open ? ns.delete(id) : ns.add(id);
          setListOpen(ns);
        },
        style: {
          width: 36,
          height: 36,
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          color: kids.length ? C.gold : C.border,
          fontSize: 11,
          cursor: kids.length ? "pointer" : "default",
          transform: open ? "rotate(-90deg)" : "none",
          transition: "transform .15s"
        }
      }, kids.length ? "◀" : "·"), /*#__PURE__*/React.createElement("div", {
        onClick: () => onNodeClick(id),
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: 1,
          minWidth: 0,
          cursor: "pointer"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          width: 38,
          height: 38,
          borderRadius: "50%",
          overflow: "hidden",
          flexShrink: 0,
          border: `2px ${p.deceased ? "dashed" : "solid"} ${p.gender === "f" ? "#b06a84" : C.goldSoft}`,
          background: "#e9e4d8",
          display: "grid",
          placeItems: "center"
        }
      }, photos[id] ? /*#__PURE__*/React.createElement("img", {
        src: photos[id],
        alt: "",
        style: {
          width: "100%",
          height: "100%",
          objectFit: "cover"
        }
      }) : /*#__PURE__*/React.createElement("span", {
        style: {
          fontFamily: "'Amiri',serif",
          fontSize: 17,
          color: "#8c857a"
        }
      }, p.name?.[0] || "؟")), /*#__PURE__*/React.createElement("div", {
        style: {
          minWidth: 0
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontFamily: "'Amiri',serif",
          fontWeight: 700,
          fontSize: 15.5,
          color: "#2c2415",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis"
        }
      }, p.name, p.nickname ? /*#__PURE__*/React.createElement("span", {
        style: {
          color: C.sub,
          fontSize: 11.5,
          fontFamily: "'Tajawal'"
        }
      }, " (", p.nickname, ")") : null), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          color: C.sub,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis"
        }
      }, p.deceased ? mercy(p) + " · " : "", kids.length ? `${descCount(id)} من الذرية` : "بلا ذرية", spousesOf(id).map(sp => " · ⚭ " + (pmap[sp]?.name || "")).join(""))))));
      if (open) kids.forEach(k => emit(k, depth + 1));
    };
    treeRoots.forEach(r => emit(r.id, 0));
    return out;
  })())), !loading && people.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "grid",
      placeItems: "center",
      pointerEvents: "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      pointerEvents: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Amiri',serif",
      fontSize: 26,
      color: C.gold,
      marginBottom: 6
    }
  }, "ابدأ ببناء شجرة عائلتك"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14,
      marginBottom: 16
    }
  }, "أضف الجد الأكبر ثم ابنِ الفروع منه"), /*#__PURE__*/React.createElement("button", {
    onClick: () => addPerson({
      name: "الجد"
    }),
    style: {
      background: C.gold,
      color: "#ffffff",
      border: "none",
      padding: "10px 22px",
      borderRadius: 8,
      fontWeight: 700,
      fontSize: 15,
      cursor: "pointer",
      fontFamily: "'Tajawal'"
    }
  }, "+ أضف أول شخص"))), !loading && visPeople.length > 0 && !(isMobile && showPanel) && (viewMode === "classic" || viewMode === "tree" && treePos) && /*#__PURE__*/React.createElement(Minimap, {
    C: C,
    people: viewMode === "classic" ? visPeople : Object.entries(treePos).map(([id, q]) => ({
      x: q.x,
      y: q.y,
      gender: pmap[id]?.gender
    })),
    view: view,
    vw: vw,
    vh: vh,
    onJump: (wx, wy) => setView(v => ({
      ...v,
      tx: vw / 2 - wx * v.s,
      ty: vh / 2 - wy * v.s
    }))
  }), viewMode !== "list" && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      bottom: 16,
      left: 16,
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(RoundBtn, {
    C: C,
    onClick: () => zoom(1.2)
  }, "+"), /*#__PURE__*/React.createElement(RoundBtn, {
    C: C,
    onClick: () => zoom(0.83)
  }, "−"), /*#__PURE__*/React.createElement(RoundBtn, {
    C: C,
    onClick: () => {
      const r = canvasRef.current?.getBoundingClientRect();
      const w0 = r ? r.width : 900,
        h0 = r ? r.height : 600;
      if (viewMode === "tree" && treePos && mainRoot && treePos[mainRoot]) {
        const s0 = w0 < 700 ? 0.85 : 0.95;
        setView({
          s: s0,
          tx: w0 / 2 - treePos[mainRoot].x * s0,
          ty: 70 - treePos[mainRoot].y * s0
        });
      } else if (viewMode === "focus") {
        setView({
          s: w0 < 700 ? 0.8 : 0.95,
          tx: w0 / 2,
          ty: h0 * 0.42
        });
      } else {
        const n0 = people[0] || {
          x: 0,
          y: 120
        };
        const s0 = w0 < 700 ? 1.1 : 0.62;
        setView({
          s: s0,
          tx: w0 / 2 - n0.x * s0,
          ty: Math.max(24, h0 * 0.16) - n0.y * s0
        });
      }
    },
    title: "إعادة الضبط"
  }, "⟳")), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 14,
      right: 14,
      width: 230
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: search,
    onChange: e => setSearch(e.target.value),
    placeholder: "بحث بالاسم…",
    style: {
      width: "100%",
      boxSizing: "border-box",
      padding: "9px 12px",
      borderRadius: 8,
      border: `1px solid ${C.border}`,
      background: "rgba(255,255,255,.97)",
      color: C.parch,
      fontFamily: "'Tajawal'",
      fontSize: 14,
      outline: "none"
    }
  }), searchHits.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4,
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      maxHeight: 320,
      overflowY: "auto"
    }
  }, searchHits.slice(0, 30).map(p => {
    const anc = [];
    let c = p.id,
      n = 0;
    while (primParent[c] && n++ < 4) {
      c = primParent[c];
      if (pmap[c]) anc.push(pmap[c].name);
    }
    const husband = !anc.length && spousesOf(p.id).map(sp => pmap[sp]?.name).filter(Boolean)[0];
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      onClick: () => focusPerson(p),
      style: {
        padding: "7px 12px",
        cursor: "pointer",
        borderBottom: `1px solid ${C.border}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Amiri',serif",
        fontWeight: 700,
        fontSize: 14.5,
        color: C.parch
      }
    }, p.name, p.nickname ? ` (${p.nickname})` : "", p.deceased ? ` · ${mercy(p)}` : ""), (anc.length > 0 || husband) && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.sub,
        marginTop: 1
      }
    }, anc.length > 0 ? `${p.gender === "f" ? "بنت" : "بن"} ${anc.join(" بن ")}${primParent[c] ? "…" : ""}` : `زوجة ${husband}`));
  })))), showPanel && /*#__PURE__*/React.createElement("div", {
    style: isMobile ? {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: "58%",
      background: C.panel,
      borderTop: `1px solid ${C.border}`,
      borderRadius: "16px 16px 0 0",
      display: "flex",
      flexDirection: "column",
      zIndex: 40,
      boxShadow: "0 -8px 30px rgba(0,0,0,.18)"
    } : {
      width: 320,
      flexShrink: 0,
      background: C.panel,
      borderRight: `1px solid ${C.border}`,
      display: "flex",
      flexDirection: "column",
      zIndex: 20
    }
  }, isMobile && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowPanel(false),
    style: {
      display: "grid",
      placeItems: "center",
      padding: "9px 0 4px",
      cursor: "pointer",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 44,
      height: 5,
      borderRadius: 3,
      background: C.border
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      borderBottom: `1px solid ${C.border}`
    }
  }, [["view", "الملف"], ["edit", "تحرير"], ["log", `السجل (${cloudLive ? revisions.length : log.length})`]].map(([k, lbl]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setTab(k),
    style: {
      flex: 1,
      padding: "12px 0",
      background: tab === k ? C.panel2 : "transparent",
      color: tab === k ? C.gold : C.sub,
      border: "none",
      borderBottom: tab === k ? `2px solid ${C.gold}` : "2px solid transparent",
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 14,
      fontWeight: 600
    }
  }, lbl))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: 16
    }
  }, tab === "view" && (selected ? /*#__PURE__*/React.createElement(ProfilePanel, {
    C: C,
    person: selected,
    photo: photos[selected.id],
    people: visPeople,
    pmap: pmap,
    edges: visEdges,
    familyMode: familyMode,
    onEdit: () => setTab("edit"),
    onUnlock: () => setShowUnlock(true),
    onSelect: id => setSelectedId(id),
    onRadial: () => setRadialRoot(selected.id)
  }) : /*#__PURE__*/React.createElement(PanelHint, {
    C: C
  })), tab === "edit" && cloudLive && !isEditor && /*#__PURE__*/React.createElement(AuthGate, {
    C: C,
    onSignIn: signIn
  }), tab === "edit" && canEdit && (selected ? /*#__PURE__*/React.createElement(EditPanel, {
    C: C,
    person: selected,
    photo: photos[selected.id],
    people: visPeople,
    edges: visEdges,
    familyMode: familyMode,
    onName: v => updatePerson(selected.id, {
      name: v
    }),
    onNameCommit: v => addLog(`تعديل الاسم إلى: ${v}`),
    onNickname: v => updatePerson(selected.id, {
      nickname: v
    }),
    onBio: v => updatePerson(selected.id, {
      bio: v
    }),
    onGender: v => updatePerson(selected.id, {
      gender: v
    }, `تعديل الجنس (${selected.name}): ${v === "f" ? "أنثى" : "ذكر"}`),
    onDob: v => updatePerson(selected.id, {
      dob: v
    }),
    onDod: v => updatePerson(selected.id, {
      dod: v
    }),
    onElderly: v => updatePerson(selected.id, {
      elderly: v
    }),
    onContact: (field, v) => updatePerson(selected.id, {
      contacts: {
        ...(selected.contacts || {}),
        [field]: v
      }
    }),
    onPoc: id => updatePerson(selected.id, {
      poc: id
    }, id ? `تعيين جهة تواصل لـ ${selected.name}` : `إزالة جهة التواصل لـ ${selected.name}`),
    onNote: v => updatePerson(selected.id, {
      note: v
    }),
    onDeceased: v => updatePerson(selected.id, {
      deceased: v
    }, v ? `تعليم متوفى: ${selected.name}` : `إلغاء تعليم المتوفى: ${selected.name}`),
    onUpload: () => fileRef.current?.click(),
    onRemovePhoto: () => removePhoto(selected.id),
    onAddChild: g => addChild(selected.id, g),
    onAddParent: g => addParent(selected.id, g),
    onAddSpouse: () => addSpouse(selected.id),
    onLinkSpouse: otherId => addEdge(selected.id, otherId, "spouse"),
    lineageOf: lineageStr,
    onDelete: () => deletePerson(selected.id),
    onRemoveEdge: removeEdge,
    onRadial: () => setRadialRoot(selected.id),
    onSelect: id => {
      setSelectedId(id);
    },
    onUnlock: () => setShowUnlock(true)
  }) : /*#__PURE__*/React.createElement(PanelHint, {
    C: C
  })), tab === "log" && cloudLive && /*#__PURE__*/React.createElement("div", null, revisions.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14
    }
  }, "لا توجد تعديلات بعد."), revisions.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.id,
    style: {
      padding: "10px 0",
      borderBottom: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: C.parch
    }
  }, r.text), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub
    }
  }, r.name ? r.name + " · " : "", fmtTime(r.ts)), isEditor && (r.before || r.kind === "add") && /*#__PURE__*/React.createElement("button", {
    onClick: () => revertRevision(r),
    style: {
      background: "transparent",
      border: `1px solid ${C.border}`,
      color: C.sub,
      borderRadius: 6,
      cursor: "pointer",
      fontSize: 11,
      fontFamily: "'Tajawal'",
      padding: "2px 8px"
    }
  }, "تراجع"))))), tab === "log" && !cloudLive && /*#__PURE__*/React.createElement("div", null, log.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14
    }
  }, "لا توجد تعديلات بعد."), log.map(l => /*#__PURE__*/React.createElement("div", {
    key: l.id,
    style: {
      padding: "10px 0",
      borderBottom: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: C.parch
    }
  }, l.text), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      marginTop: 2
    }
  }, fmtTime(l.ts)))))))), /*#__PURE__*/React.createElement("input", {
    ref: fileRef,
    type: "file",
    accept: "image/*",
    style: {
      display: "none"
    },
    onChange: e => {
      if (selected) handlePhoto(selected.id, e.target.files[0]);
      e.target.value = "";
    }
  }), radialRoot && (() => {
    const kids = {};
    visEdges.filter(e => e.type !== "spouse").forEach(e => {
      (kids[e.from] = kids[e.from] || []).push(e.to);
    });
    const W = 920,
      H = 920,
      ccx = W / 2,
      ccy = H / 2,
      RING = 150;
    const ns = [],
      ls = [];
    const lay = (id, depth, a0, a1, par) => {
      const ang = (a0 + a1) / 2,
        r = depth * RING;
      const x = ccx + r * Math.cos(ang),
        y = ccy + r * Math.sin(ang);
      const pp = pmap[id];
      if (!pp) return;
      const pos = {
        id,
        x,
        y,
        depth,
        name: pp.name,
        dead: pp.deceased,
        f: pp.gender === "f"
      };
      ns.push(pos);
      if (par) ls.push({
        a: par,
        b: pos
      });
      const ks = (kids[id] || []).slice(0, 12);
      if (ks.length && depth < 3) {
        const sp = (a1 - a0) / ks.length;
        ks.forEach((k, i) => lay(k, depth + 1, a0 + i * sp, a0 + (i + 1) * sp, pos));
      }
    };
    lay(radialRoot, 0, -Math.PI / 2, Math.PI * 1.5, null);
    const NR = d => d === 0 ? 44 : d === 1 ? 32 : 24;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        position: "absolute",
        inset: 0,
        background: C.bg,
        zIndex: 60,
        overflow: "auto",
        display: "flex",
        flexDirection: "column"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 18px",
        borderBottom: `1px solid ${C.border}`,
        flexShrink: 0,
        background: "#fff"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Amiri',serif",
        fontSize: 20,
        color: C.gold,
        fontWeight: 700
      }
    }, "عرض دائري — فرع ", pmap[radialRoot]?.name), /*#__PURE__*/React.createElement(Btn, {
      C: C,
      onClick: () => setRadialRoot(null)
    }, "عودة للشجرة")), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        overflow: "auto",
        display: "grid",
        placeItems: "center",
        padding: 10
      }
    }, /*#__PURE__*/React.createElement("svg", {
      viewBox: `0 0 ${W} ${H}`,
      style: {
        width: "100%",
        maxWidth: 900
      }
    }, [1, 2, 3].map(r => /*#__PURE__*/React.createElement("circle", {
      key: r,
      cx: ccx,
      cy: ccy,
      r: r * RING,
      fill: "none",
      stroke: "#e4dfd4"
    })), ls.map((l, i) => /*#__PURE__*/React.createElement("line", {
      key: i,
      x1: l.a.x,
      y1: l.a.y,
      x2: l.b.x,
      y2: l.b.y,
      stroke: C.line,
      strokeWidth: "1.5"
    })), ns.map((n, i) => {
      const rr = NR(n.depth),
        ph = photos[n.id];
      return /*#__PURE__*/React.createElement("g", {
        key: i,
        style: {
          cursor: "pointer"
        },
        onClick: () => {
          if ((kids[n.id] || []).length) setRadialRoot(n.id);
        }
      }, /*#__PURE__*/React.createElement("circle", {
        cx: n.x,
        cy: n.y,
        r: rr + 2,
        fill: "#fff",
        stroke: n.depth === 0 ? C.gold : "#ddd7c9",
        strokeWidth: n.depth === 0 ? 3 : 2
      }), ph ? /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("clipPath", {
        id: "rc" + i
      }, /*#__PURE__*/React.createElement("circle", {
        cx: n.x,
        cy: n.y,
        r: rr
      })), /*#__PURE__*/React.createElement("image", {
        href: ph,
        x: n.x - rr,
        y: n.y - rr,
        width: rr * 2,
        height: rr * 2,
        clipPath: `url(#rc${i})`,
        preserveAspectRatio: "xMidYMid slice"
      })) : /*#__PURE__*/React.createElement("circle", {
        cx: n.x,
        cy: n.y,
        r: rr,
        fill: "#e9e4d8"
      }), /*#__PURE__*/React.createElement("text", {
        x: n.x,
        y: n.y + rr + 14,
        textAnchor: "middle",
        fontSize: n.depth === 0 ? 15 : 12,
        fontFamily: "serif",
        fontWeight: "700",
        fill: C.parch
      }, n.name), n.dead && /*#__PURE__*/React.createElement("text", {
        x: n.x,
        y: n.y + rr + 27,
        textAnchor: "middle",
        fontSize: "10",
        fill: C.sub
      }, n.f ? "رحمها الله" : "رحمه الله"));
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        color: C.sub,
        fontSize: 12,
        padding: "0 0 10px"
      }
    }, "اضغط أي شخص لجعله المركز · \"عودة للشجرة\" للرجوع"));
  })(), showUnlock && /*#__PURE__*/React.createElement(UnlockModal, {
    C: C,
    onTry: tryUnlock,
    onClose: () => setShowUnlock(false)
  }), showStats && /*#__PURE__*/React.createElement(StatsOverlay, {
    C: C,
    people: visPeople,
    edges: visEdges,
    photos: photos,
    familyMode: familyMode,
    onClose: () => setShowStats(false)
  }), showGallery && /*#__PURE__*/React.createElement(GalleryOverlay, {
    C: C,
    people: visPeople,
    photos: photos,
    onClose: () => setShowGallery(false),
    onOpen: p => {
      setShowGallery(false);
      focusPerson(p);
    }
  }), busyMsg && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      background: "rgba(43,42,37,.5)",
      zIndex: 90,
      display: "grid",
      placeItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#fff",
      borderRadius: 12,
      padding: "20px 34px",
      fontFamily: "'Amiri',serif",
      fontSize: 18,
      color: C.gold
    }
  }, busyMsg)), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      display: "grid",
      placeItems: "center",
      background: C.bg,
      zIndex: 50
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.gold,
      fontFamily: "'Amiri',serif",
      fontSize: 20
    }
  }, "جارٍ التحميل…")));
}

// ====================== Sub-components ======================
function Btn({
  children,
  onClick,
  active,
  C
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      background: active ? C.gold : "transparent",
      color: active ? "#ffffff" : C.parch,
      border: `1px solid ${active ? C.gold : C.border}`,
      padding: "7px 14px",
      borderRadius: 7,
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 13,
      fontWeight: 600,
      whiteSpace: "nowrap"
    }
  }, children);
}
function RoundBtn({
  children,
  onClick,
  C,
  title
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    title: title,
    style: {
      width: 38,
      height: 38,
      borderRadius: 9,
      background: "rgba(255,255,255,.96)",
      color: C.gold,
      border: `1px solid ${C.border}`,
      cursor: "pointer",
      fontSize: 18,
      fontWeight: 700
    }
  }, children);
}
function PanelHint({
  C
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14,
      lineHeight: 1.9,
      textAlign: "center",
      marginTop: 30
    }
  }, "اختر شخصًا من الشجرة لعرض ملفه أو تحريره،", /*#__PURE__*/React.createElement("br", null), "أو اضغط \"+ شخص\" لإضافة فرد جديد.", /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 20,
      fontSize: 12,
      color: C.line,
      textAlign: "right",
      lineHeight: 2
    }
  }, "· اسحب الخلفية للتنقل", /*#__PURE__*/React.createElement("br", null), "· عجلة الفأرة أو إصبعان للتكبير", /*#__PURE__*/React.createElement("br", null), "· \"ربط شخصين\" لرسم خط بينهما", /*#__PURE__*/React.createElement("br", null), "· \"🔒 الوضع العائلي\" لعرض بيانات التواصل والمواليد"));
}
function LockedHint({
  C,
  onUnlock,
  text
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.panel2,
      border: `1px dashed ${C.border}`,
      borderRadius: 8,
      padding: "10px 12px",
      fontSize: 12.5,
      color: C.sub,
      marginBottom: 14,
      lineHeight: 1.8
    }
  }, "🔒 ", text, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    onClick: onUnlock,
    style: {
      color: C.gold,
      cursor: "pointer",
      fontWeight: 700,
      textDecoration: "underline"
    }
  }, "إدخال رمز العائلة")));
}
function ContactLinks({
  C,
  person
}) {
  const c = person.contacts || {};
  const links = [["واتساب", waLink(c.whatsapp), "#25D366"], ["البريد", mailLink(c.email), "#8a6d3b"], ["لينكدإن", liLink(c.linkedin), "#0A66C2"], ["إكس / تويتر", twLink(c.twitter), "#333333"]].filter(([, url]) => url);
  if (!links.length) return /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub
    }
  }, "لا توجد بيانات تواصل مسجلة.");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap"
    }
  }, links.map(([lbl, url, col]) => /*#__PURE__*/React.createElement("a", {
    key: lbl,
    href: url,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      background: col,
      color: "#fff",
      padding: "7px 14px",
      borderRadius: 7,
      fontSize: 13,
      fontWeight: 600,
      textDecoration: "none",
      fontFamily: "'Tajawal'"
    }
  }, lbl)));
}
function PhotoLightbox({
  photo,
  name,
  onClose
}) {
  const [dim, setDim] = useState(null);
  useEffect(() => {
    const onKey = e => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(20,18,14,.9)",
      zIndex: 120,
      display: "grid",
      placeItems: "center",
      cursor: "zoom-out"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      maxWidth: "94vw"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: photo,
    alt: name,
    onLoad: e => setDim({
      w: e.target.naturalWidth,
      h: e.target.naturalHeight
    }),
    style: {
      maxWidth: "94vw",
      maxHeight: "80vh",
      borderRadius: 10,
      boxShadow: "0 20px 60px rgba(0,0,0,.55)"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#f0ece2",
      fontFamily: "'Tajawal'",
      fontSize: 15,
      marginTop: 12,
      fontWeight: 600
    }
  }, name, dim ? ` — الأبعاد: ${dim.w} × ${dim.h} بكسل` : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#b7ae9d",
      fontFamily: "'Tajawal'",
      fontSize: 12,
      marginTop: 4
    }
  }, "اضغط في أي مكان للإغلاق")));
}
function ProfilePanel({
  C,
  person,
  photo,
  people,
  pmap,
  edges,
  familyMode,
  onEdit,
  onUnlock,
  onSelect,
  onRadial
}) {
  const sect = {
    fontSize: 13,
    color: C.gold,
    margin: "16px 0 8px",
    fontWeight: 700
  };
  const [zoomPhoto, setZoomPhoto] = useState(false);

  // paternal lineage chain: فلان بن فلان بن فلان…
  const chain = [];
  let cur = person.id;
  for (let i = 0; i < 12; i++) {
    const ps = edges.filter(e => e.type !== "spouse" && e.to === cur).map(e => pmap[e.from]).filter(Boolean);
    const father = ps.find(p => p.gender !== "f") || ps[0];
    if (!father) break;
    chain.push(father);
    cur = father.id;
  }
  const bin = person.gender === "f" ? "بنت" : "بن";
  const age = ageOf(person);
  const spouses = edges.filter(e => e.type === "spouse" && (e.from === person.id || e.to === person.id)).map(e => pmap[e.from === person.id ? e.to : e.from]).filter(Boolean);
  const kids = edges.filter(e => e.type !== "spouse" && e.from === person.id).map(e => pmap[e.to]).filter(Boolean);
  const poc = person.poc ? pmap[person.poc] : null;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      marginBottom: 6
    }
  }, photo ? /*#__PURE__*/React.createElement("div", {
    onClick: () => setZoomPhoto(true),
    title: "اضغط لعرض الصورة بالحجم الكامل",
    style: {
      cursor: "zoom-in",
      textAlign: "center",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: photo,
    alt: `صورة ${person.name}`,
    style: {
      maxWidth: "100%",
      maxHeight: 190,
      objectFit: "contain",
      display: "block",
      borderRadius: 12,
      border: `3px solid ${person.gender === "f" ? "#b06a84" : C.gold}`,
      boxShadow: "0 4px 14px rgba(0,0,0,.12)",
      margin: "0 auto"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      marginTop: 5
    }
  }, "🔍 اضغط للتكبير")) : /*#__PURE__*/React.createElement("div", {
    style: {
      width: 96,
      height: 96,
      borderRadius: "50%",
      overflow: "hidden",
      border: `3px solid ${person.gender === "f" ? "#b06a84" : C.gold}`,
      background: "#d8c9a8",
      display: "grid",
      placeItems: "center",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Amiri',serif",
      fontSize: 40,
      color: "#8a754a"
    }
  }, person.name?.[0] || "؟")), zoomPhoto && photo && /*#__PURE__*/React.createElement(PhotoLightbox, {
    photo: photo,
    name: person.name,
    onClose: () => setZoomPhoto(false)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Amiri',serif",
      fontSize: 22,
      fontWeight: 700,
      color: "#2c2415",
      textAlign: "center"
    }
  }, person.name), person.nickname && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub
    }
  }, person.nickname), person.deceased && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#7a6a47",
      fontFamily: "'Amiri',serif"
    }
  }, mercy(person)), person.elderly && !person.deceased && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "#8a6d3b",
      background: "#f7efdc",
      padding: "2px 10px",
      borderRadius: 10,
      marginTop: 4
    }
  }, "كبير السن — أطال الله عمره")), chain.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub,
      textAlign: "center",
      lineHeight: 1.9,
      marginBottom: 4
    }
  }, person.name, " ", bin, " ", chain.map(a => a.name).join(" بن ")), person.bio && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "نبذة"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13.5,
      lineHeight: 2,
      whiteSpace: "pre-line",
      color: C.parch
    }
  }, person.bio)), /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "الميلاد والعمر"), familyMode ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      lineHeight: 1.9
    }
  }, person.dob ? /*#__PURE__*/React.createElement(React.Fragment, null, "تاريخ الميلاد: ", fmtDate(person.dob), hijriOf(person.dob) ? ` (${hijriOf(person.dob)} تقريبًا)` : "", age != null && !person.deceased ? ` · العمر ${age} سنة تقريبًا` : "") : /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.sub,
      fontSize: 13
    }
  }, "لم يُسجل تاريخ الميلاد."), person.deceased && person.dod && /*#__PURE__*/React.createElement("div", null, "سنة الوفاة: ", yearOf(person.dod), hijriOf(person.dod) ? ` (${hijriOf(person.dod)} تقريبًا)` : "", age != null ? ` · عن عمر ${age} سنة تقريبًا` : "")) : /*#__PURE__*/React.createElement(LockedHint, {
    C: C,
    onUnlock: onUnlock,
    text: "تواريخ الميلاد تظهر في الوضع العائلي فقط."
  }), /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "التواصل"), familyMode ? person.deceased || person.elderly ? poc ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      lineHeight: 2
    }
  }, "جهة التواصل: ", /*#__PURE__*/React.createElement("span", {
    onClick: () => onSelect(poc.id),
    style: {
      color: C.gold,
      cursor: "pointer",
      fontWeight: 700,
      textDecoration: "underline"
    }
  }, poc.name), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement(ContactLinks, {
    C: C,
    person: poc
  }))) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub
    }
  }, "لم تُحدد جهة تواصل بعد.") : /*#__PURE__*/React.createElement(ContactLinks, {
    C: C,
    person: person
  }) : /*#__PURE__*/React.createElement(LockedHint, {
    C: C,
    onUnlock: onUnlock,
    text: "بيانات التواصل تظهر في الوضع العائلي فقط."
  }), (spouses.length > 0 || kids.length > 0) && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "الأسرة"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13.5,
      lineHeight: 2
    }
  }, spouses.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.id
  }, s.gender === "f" ? "الزوجة" : "الزوج", ": ", /*#__PURE__*/React.createElement("span", {
    onClick: () => onSelect(s.id),
    style: {
      color: C.gold,
      cursor: "pointer"
    }
  }, s.name))), kids.length > 0 && /*#__PURE__*/React.createElement("div", null, "الأبناء (", kids.length, "): ", kids.map((k, i) => /*#__PURE__*/React.createElement("span", {
    key: k.id
  }, /*#__PURE__*/React.createElement("span", {
    onClick: () => onSelect(k.id),
    style: {
      color: C.gold,
      cursor: "pointer"
    }
  }, k.name), i < kids.length - 1 ? "، " : ""))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onEdit,
    style: {
      flex: 1,
      padding: "10px",
      borderRadius: 7,
      border: "none",
      background: C.gold,
      color: "#fff",
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 14,
      fontWeight: 600
    }
  }, "تحرير البيانات"), /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: onRadial
  }, "عرض دائري")), /*#__PURE__*/React.createElement(ShareButton, {
    C: C,
    person: person
  }));
}
function ShareButton({
  C,
  person
}) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = window.location.origin + window.location.pathname + "#p=" + encodeURIComponent(person.id);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("انسخ الرابط:", url);
    }
  };
  return /*#__PURE__*/React.createElement("button", {
    onClick: share,
    style: {
      width: "100%",
      marginTop: 8,
      padding: "9px",
      borderRadius: 7,
      border: `1px solid ${C.border}`,
      background: "transparent",
      color: copied ? C.gold : C.sub,
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 13,
      fontWeight: 600
    }
  }, copied ? "✓ تم نسخ الرابط" : "🔗 نسخ رابط هذا الشخص");
}
function Minimap({
  C,
  people,
  view,
  vw,
  vh,
  onJump
}) {
  const ref = useRef(null);
  const boundsRef = useRef(null);
  const MW = 220,
    MH = 110;
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !people.length) return;
    const xs = people.map(p => p.x),
      ys = people.map(p => p.y);
    const minX = Math.min(...xs) - 800,
      maxX = Math.max(...xs) + 800;
    const minY = Math.min(...ys) - 400,
      maxY = Math.max(...ys) + 400;
    const sx = MW / (maxX - minX),
      sy = MH / (maxY - minY);
    boundsRef.current = {
      minX,
      minY,
      sx,
      sy
    };
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, MW, MH);
    for (const p of people) {
      ctx.fillStyle = p.gender === "f" ? "#b06a84" : "#2f7d62";
      ctx.fillRect((p.x - minX) * sx, (p.y - minY) * sy, 1.6, 1.6);
    }
    const rx = (-view.tx / view.s - minX) * sx,
      ry = (-view.ty / view.s - minY) * sy;
    const rw = Math.max(vw / view.s * sx, 6),
      rh = Math.max(vh / view.s * sy, 6);
    ctx.strokeStyle = "#e0a23a";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
  }, [people, view, vw, vh]);
  const jump = e => {
    const b = boundsRef.current;
    if (!b) return;
    const r = ref.current.getBoundingClientRect();
    const px = (e.clientX - r.left) * (MW / r.width);
    const py = (e.clientY - r.top) * (MH / r.height);
    onJump(px / b.sx + b.minX, py / b.sy + b.minY);
  };
  return /*#__PURE__*/React.createElement("canvas", {
    ref: ref,
    width: MW,
    height: MH,
    onPointerDown: e => {
      e.stopPropagation();
      jump(e);
    },
    onPointerMove: e => {
      if (e.buttons === 1) {
        e.stopPropagation();
        jump(e);
      }
    },
    style: {
      position: "absolute",
      bottom: 16,
      right: 14,
      width: MW,
      height: MH,
      background: "rgba(255,255,255,.93)",
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      cursor: "crosshair",
      boxShadow: "0 3px 10px rgba(0,0,0,.10)",
      touchAction: "none"
    }
  });
}
function PocPicker({
  C,
  people,
  value,
  onChange
}) {
  const [q, setQ] = useState("");
  const chosen = value ? people.find(p => p.id === value) : null;
  const nq = normAr(q);
  const hits = nq ? people.filter(p => !p.deceased && (normAr(p.name).includes(nq) || normAr(p.nickname).includes(nq))).slice(0, 8) : [];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, chosen ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "8px 11px",
      background: C.panel2,
      borderRadius: 7,
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("span", null, chosen.name, chosen.nickname ? ` (${chosen.nickname})` : ""), /*#__PURE__*/React.createElement("button", {
    onClick: () => onChange(null),
    style: {
      background: "transparent",
      border: "none",
      color: "#c0392b",
      cursor: "pointer",
      fontSize: 12
    }
  }, "إزالة")) : /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: "ابحث عن اسم جهة التواصل…",
    style: {
      width: "100%",
      boxSizing: "border-box",
      padding: "9px 11px",
      borderRadius: 7,
      border: `1px solid ${C.border}`,
      background: C.panel2,
      color: C.parch,
      fontFamily: "'Tajawal'",
      fontSize: 14,
      outline: "none"
    }
  }), hits.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${C.border}`,
      borderRadius: 7,
      marginTop: 4,
      maxHeight: 180,
      overflowY: "auto"
    }
  }, hits.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    onClick: () => {
      onChange(p.id);
      setQ("");
    },
    style: {
      padding: "7px 11px",
      fontSize: 13.5,
      cursor: "pointer",
      borderBottom: `1px solid ${C.border}`
    }
  }, p.name, p.nickname ? ` (${p.nickname})` : "")))));
}

// searchable picker to marry two people who both already exist in the tree
function SpousePicker({
  C,
  people,
  person,
  edges,
  lineageOf,
  onPick
}) {
  const [q, setQ] = useState("");
  const existing = new Set(edges.filter(e => e.type === "spouse" && (e.from === person.id || e.to === person.id)).map(e => e.from === person.id ? e.to : e.from));
  const nq = normAr(q);
  const hits = nq ? people.filter(p => p.id !== person.id && p.gender === "f" !== (person.gender === "f") && !existing.has(p.id) && (normAr(p.name).includes(nq) || normAr(p.nickname).includes(nq))).slice(0, 8) : [];
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: person.gender === "f" ? "ابحث عن اسم الزوج…" : "ابحث عن اسم الزوجة…",
    style: {
      width: "100%",
      boxSizing: "border-box",
      padding: "9px 11px",
      borderRadius: 7,
      border: `1px solid ${C.border}`,
      background: C.panel2,
      color: C.parch,
      fontFamily: "'Tajawal'",
      fontSize: 14,
      outline: "none"
    }
  }), hits.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      border: `1px solid ${C.border}`,
      borderRadius: 7,
      marginTop: 4,
      maxHeight: 220,
      overflowY: "auto"
    }
  }, hits.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    onClick: () => {
      onPick(p.id);
      setQ("");
    },
    style: {
      padding: "7px 11px",
      cursor: "pointer",
      borderBottom: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Amiri',serif",
      fontWeight: 700,
      fontSize: 14,
      color: C.parch
    }
  }, p.name, p.nickname ? ` (${p.nickname})` : ""), lineageOf(p.id) && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10.5,
      color: C.sub
    }
  }, lineageOf(p.id))))), nq && !hits.length && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      marginTop: 6
    }
  }, "لا نتائج مطابقة داخل الشجرة."));
}
function UnlockModal({
  C,
  onTry,
  onClose
}) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!code || busy) return;
    setBusy(true);
    const ok = await onTry(code);
    setBusy(false);
    if (!ok) {
      setErr(true);
      setCode("");
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      background: "rgba(43,42,37,.45)",
      zIndex: 80,
      display: "grid",
      placeItems: "center"
    },
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      background: "#fff",
      borderRadius: 12,
      padding: 24,
      width: 320,
      maxWidth: "88vw",
      boxShadow: "0 18px 50px rgba(0,0,0,.25)",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Amiri',serif",
      fontSize: 20,
      fontWeight: 700,
      color: C.gold,
      marginBottom: 6
    }
  }, "الوضع العائلي"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub,
      lineHeight: 1.9,
      marginBottom: 14
    }
  }, "أدخل رمز العائلة لعرض بيانات التواصل وتواريخ الميلاد وأفراد العائلة من النساء."), /*#__PURE__*/React.createElement("input", {
    type: "password",
    value: code,
    autoFocus: true,
    onChange: e => {
      setCode(e.target.value);
      setErr(false);
    },
    onKeyDown: e => {
      if (e.key === "Enter") submit();
    },
    placeholder: "رمز العائلة",
    style: {
      width: "100%",
      boxSizing: "border-box",
      padding: "10px 12px",
      borderRadius: 8,
      border: `1px solid ${err ? "#c0392b" : C.border}`,
      background: C.panel2,
      fontFamily: "'Tajawal'",
      fontSize: 15,
      outline: "none",
      textAlign: "center",
      marginBottom: 8
    }
  }), err && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: "#c0392b",
      marginBottom: 8
    }
  }, "رمز غير صحيح، حاول مرة أخرى."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: submit,
    disabled: busy,
    style: {
      flex: 1,
      padding: "10px",
      borderRadius: 8,
      border: "none",
      background: C.gold,
      color: "#fff",
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 14,
      fontWeight: 700
    }
  }, busy ? "جارٍ التحقق…" : "دخول"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      padding: "10px 16px",
      borderRadius: 8,
      border: `1px solid ${C.border}`,
      background: "transparent",
      color: C.sub,
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 14
    }
  }, "إلغاء"))));
}
function AuthGate({
  C,
  onSignIn
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.panel2,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "18px 16px",
      textAlign: "center",
      fontSize: 14,
      lineHeight: 2,
      color: C.parch
    }
  }, "الشجرة الآن مشتركة ومباشرة ☁", /*#__PURE__*/React.createElement("br", null), "للتحرير، سجّل الدخول بحساب Google — تعديلاتك تظهر للجميع باسمك ويمكن التراجع عنها من السجل.", /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("button", {
    onClick: onSignIn,
    style: {
      background: C.gold,
      color: "#fff",
      border: "none",
      padding: "9px 20px",
      borderRadius: 8,
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 14,
      fontWeight: 700,
      marginTop: 8
    }
  }, "تسجيل الدخول بحساب Google")));
}

// compact avatar node used by the tree and focus views (anchor = avatar center)
function MiniNode({
  C,
  p,
  x,
  y,
  photo,
  selected,
  focusCard,
  onTap
}) {
  const isF = p.gender === "f";
  const ring = selected ? C.gold : isF ? "#b06a84" : C.goldSoft;
  const size = focusCard ? 84 : 56;
  return /*#__PURE__*/React.createElement("div", {
    onClick: e => {
      e.stopPropagation();
      onTap && onTap(p.id);
    },
    style: {
      position: "absolute",
      left: x,
      top: y,
      transform: `translate(-50%, -${size / 2}px)`,
      width: 112,
      textAlign: "center",
      cursor: "pointer",
      userSelect: "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: size,
      height: size,
      margin: "0 auto",
      borderRadius: "50%",
      overflow: "hidden",
      border: `${selected || focusCard ? 3 : 2}px ${p.deceased ? "dashed" : "solid"} ${ring}`,
      background: "#e9e4d8",
      display: "grid",
      placeItems: "center",
      boxShadow: selected ? "0 0 0 4px rgba(47,125,98,.22)" : "0 2px 8px rgba(0,0,0,.12)"
    }
  }, photo ? /*#__PURE__*/React.createElement("img", {
    src: photo,
    alt: "",
    style: {
      width: "100%",
      height: "100%",
      objectFit: "cover"
    }
  }) : /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Amiri',serif",
      fontSize: size * 0.42,
      color: "#8c857a"
    }
  }, p.name?.[0] || "؟")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Amiri',serif",
      fontWeight: 700,
      fontSize: focusCard ? 16 : 13,
      marginTop: 3,
      lineHeight: 1.25,
      color: "#2c2415",
      overflow: "hidden",
      display: "-webkit-box",
      WebkitLineClamp: 2,
      WebkitBoxOrient: "vertical"
    }
  }, p.name), p.deceased && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: "#7a6a47",
      fontFamily: "'Tajawal'"
    }
  }, mercy(p)));
}

// dropdown date picker; stores "YYYY", "YYYY-MM" or "YYYY-MM-DD" (month/day optional)
function DateSelect({
  C,
  value,
  onChange,
  yearOnly
}) {
  const m = String(value || "").match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  const y = m ? +m[1] : "",
    mo = m && m[2] ? +m[2] : "",
    d = m && m[3] ? +m[3] : "";
  const nowY = new Date().getFullYear();
  const years = [];
  for (let i = nowY; i >= 1850; i--) years.push(i);
  const daysIn = (yy, mm) => new Date(yy || 2000, mm, 0).getDate();
  const emit = (ny, nm, nd) => {
    if (!ny) return onChange("");
    let s = String(ny);
    if (nm) {
      s += "-" + String(nm).padStart(2, "0");
      if (nd) s += "-" + String(nd).padStart(2, "0");
    }
    onChange(s);
  };
  const sel = {
    flex: 1,
    minWidth: 0,
    padding: "8px 6px",
    borderRadius: 7,
    border: `1px solid ${C.border}`,
    background: C.panel2,
    color: C.parch,
    fontFamily: "'Tajawal'",
    fontSize: 13.5,
    outline: "none"
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: y,
    style: sel,
    onChange: e => {
      const ny = +e.target.value || "";
      emit(ny, ny ? mo : "", ny && mo ? Math.min(d || 0, daysIn(ny, mo)) || "" : "");
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "السنة"), years.map(yy => /*#__PURE__*/React.createElement("option", {
    key: yy,
    value: yy
  }, yy))), !yearOnly && /*#__PURE__*/React.createElement("select", {
    value: mo,
    style: sel,
    disabled: !y,
    onChange: e => {
      const nm = +e.target.value || "";
      emit(y, nm, nm ? Math.min(d || 0, daysIn(y, nm)) || "" : "");
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "الشهر"), AR_MONTHS.map((nm, i) => /*#__PURE__*/React.createElement("option", {
    key: i,
    value: i + 1
  }, nm))), !yearOnly && /*#__PURE__*/React.createElement("select", {
    value: d,
    style: {
      ...sel,
      maxWidth: 76
    },
    disabled: !mo,
    onChange: e => emit(y, mo, +e.target.value || "")
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "اليوم"), mo ? Array.from({
    length: daysIn(y, mo)
  }, (_, i) => i + 1).map(dd => /*#__PURE__*/React.createElement("option", {
    key: dd,
    value: dd
  }, dd)) : null));
}

// input restricted + validated per field type, with an inline error hint
function VInput({
  C,
  label,
  value,
  onChange,
  field,
  placeholder,
  inputMode
}) {
  const err = fieldValidators[field] ? fieldValidators[field](value || "") : "";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: {
      fontSize: 12,
      color: C.sub,
      marginBottom: 5,
      display: "block"
    }
  }, label), /*#__PURE__*/React.createElement("input", {
    value: value || "",
    dir: "ltr",
    inputMode: inputMode,
    placeholder: placeholder,
    onChange: e => onChange(fieldFilters[field] ? fieldFilters[field](e.target.value) : e.target.value),
    style: {
      width: "100%",
      boxSizing: "border-box",
      padding: "9px 11px",
      borderRadius: 7,
      border: `1px solid ${err ? "#c0392b" : C.border}`,
      background: C.panel2,
      color: C.parch,
      fontFamily: "'Tajawal'",
      fontSize: 14,
      outline: "none"
    }
  }), err && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "#c0392b",
      marginTop: 4
    }
  }, err));
}
function EditPanel({
  C,
  person,
  photo,
  people,
  edges,
  familyMode,
  onRadial,
  onName,
  onNameCommit,
  onNickname,
  onBio,
  onGender,
  onDob,
  onDod,
  onElderly,
  onContact,
  onPoc,
  onNote,
  onDeceased,
  onUpload,
  onRemovePhoto,
  onAddChild,
  onAddParent,
  onAddSpouse,
  onLinkSpouse,
  lineageOf,
  onDelete,
  onRemoveEdge,
  onSelect,
  onUnlock
}) {
  const label = {
    fontSize: 12,
    color: C.sub,
    marginBottom: 5,
    display: "block"
  };
  const inp = {
    width: "100%",
    boxSizing: "border-box",
    padding: "9px 11px",
    borderRadius: 7,
    border: `1px solid ${C.border}`,
    background: C.panel2,
    color: C.parch,
    fontFamily: "'Tajawal'",
    fontSize: 14,
    outline: "none",
    marginBottom: 14
  };
  const sect = {
    fontSize: 13,
    color: C.gold,
    margin: "4px 0 10px",
    fontWeight: 700
  };
  const [showSpousePick, setShowSpousePick] = useState(false);
  const parents = edges.filter(e => e.type !== "spouse" && e.to === person.id);
  const children = edges.filter(e => e.type !== "spouse" && e.from === person.id);
  const spouses = edges.filter(e => e.type === "spouse" && (e.from === person.id || e.to === person.id));
  const personOf = id => people.find(p => p.id === id);
  const nameOf = id => personOf(id)?.name || "؟";
  const contacts = person.contacts || {};
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 96,
      height: 96,
      borderRadius: "50%",
      overflow: "hidden",
      border: `3px solid ${person.gender === "f" ? "#b06a84" : C.gold}`,
      background: "#d8c9a8",
      display: "grid",
      placeItems: "center",
      marginBottom: 10
    }
  }, photo ? /*#__PURE__*/React.createElement("img", {
    src: photo,
    alt: "",
    style: {
      width: "100%",
      height: "100%",
      objectFit: "cover"
    }
  }) : /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Amiri',serif",
      fontSize: 40,
      color: "#8a754a"
    }
  }, person.name?.[0] || "؟")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: onUpload
  }, photo ? "تغيير الصورة" : "رفع صورة"), photo && /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: onRemovePhoto
  }, "حذف الصورة"))), /*#__PURE__*/React.createElement("label", {
    style: label
  }, person.gender === "f" ? "الاسم (يمكن كتابة اسم العائلة، مثل «نورة العتيبي»)" : "الاسم (كلمة واحدة — المركّب يُكتب موصولًا مثل «عبدالله»)"), /*#__PURE__*/React.createElement("input", {
    value: person.name,
    onChange: e => onName(person.gender === "f" ? e.target.value : e.target.value.replace(/\s+/g, "")),
    onBlur: e => onNameCommit(e.target.value),
    style: inp
  }), /*#__PURE__*/React.createElement("label", {
    style: label
  }, "الكنية / اللقب (أبو فلان…)"), /*#__PURE__*/React.createElement("input", {
    value: person.nickname || "",
    onChange: e => onNickname(e.target.value),
    style: inp
  }), /*#__PURE__*/React.createElement("label", {
    style: label
  }, "نبذة مختصرة (سيرة، عمل، مواقف تُذكر…)"), /*#__PURE__*/React.createElement("textarea", {
    value: person.bio || "",
    onChange: e => onBio(e.target.value),
    rows: 4,
    style: {
      ...inp,
      resize: "vertical",
      minHeight: 72,
      fontFamily: "'Tajawal'",
      lineHeight: 1.8
    }
  }), /*#__PURE__*/React.createElement("label", {
    style: label
  }, "الجنس"), /*#__PURE__*/React.createElement("select", {
    value: person.gender || "m",
    onChange: e => onGender(e.target.value),
    style: {
      ...inp,
      appearance: "auto"
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "m"
  }, "ذكر"), /*#__PURE__*/React.createElement("option", {
    value: "f",
    disabled: !familyMode && person.gender !== "f"
  }, "أنثى")), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 10,
      cursor: "pointer",
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!person.deceased,
    onChange: e => onDeceased(e.target.checked),
    style: {
      width: 17,
      height: 17,
      accentColor: C.gold
    }
  }), "متوفى (", mercy(person), ")"), /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 14,
      cursor: "pointer",
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!person.elderly,
    onChange: e => onElderly(e.target.checked),
    style: {
      width: 17,
      height: 17,
      accentColor: C.gold
    }
  }), "كبير السن (يُتواصل معه عبر جهة تواصل)"), familyMode ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "الميلاد والوفاة"), /*#__PURE__*/React.createElement("label", {
    style: label
  }, "تاريخ الميلاد (السنة تكفي، الشهر واليوم اختياريان)"), /*#__PURE__*/React.createElement(DateSelect, {
    C: C,
    value: person.dob,
    onChange: onDob
  }), person.deceased && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: label
  }, "سنة الوفاة"), /*#__PURE__*/React.createElement(DateSelect, {
    C: C,
    value: person.dod,
    onChange: onDod,
    yearOnly: true
  })), /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "بيانات التواصل"), /*#__PURE__*/React.createElement(VInput, {
    C: C,
    field: "whatsapp",
    inputMode: "tel",
    label: "واتساب (رقم دولي)",
    placeholder: "+9665xxxxxxxx",
    value: contacts.whatsapp,
    onChange: v => onContact("whatsapp", v)
  }), /*#__PURE__*/React.createElement(VInput, {
    C: C,
    field: "email",
    inputMode: "email",
    label: "البريد الإلكتروني",
    placeholder: "name@example.com",
    value: contacts.email,
    onChange: v => onContact("email", v)
  }), /*#__PURE__*/React.createElement(VInput, {
    C: C,
    field: "linkedin",
    label: "لينكدإن (رابط أو اسم مستخدم)",
    placeholder: "linkedin.com/in/…",
    value: contacts.linkedin,
    onChange: v => onContact("linkedin", v)
  }), /*#__PURE__*/React.createElement(VInput, {
    C: C,
    field: "twitter",
    label: "إكس / تويتر (اسم المستخدم)",
    placeholder: "@username",
    value: contacts.twitter,
    onChange: v => onContact("twitter", v)
  }), /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "جهة التواصل (للمتوفى أو كبير السن)"), /*#__PURE__*/React.createElement(PocPicker, {
    C: C,
    people: people,
    value: person.poc,
    onChange: onPoc
  })) : /*#__PURE__*/React.createElement(LockedHint, {
    C: C,
    onUnlock: onUnlock,
    text: "تحرير تواريخ الميلاد وبيانات التواصل متاح في الوضع العائلي فقط."
  }), /*#__PURE__*/React.createElement("label", {
    style: label
  }, "ملاحظة (الفرع، معلومات إضافية…)"), /*#__PURE__*/React.createElement("input", {
    value: person.note,
    onChange: e => onNote(e.target.value),
    style: inp
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginBottom: 6,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: () => onAddParent("m")
  }, "+ والد"), /*#__PURE__*/React.createElement("span", {
    style: familyMode ? {} : {
      opacity: 0.45
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: familyMode ? () => onAddParent("f") : onUnlock
  }, "+ والدة")), /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: () => onAddChild("m")
  }, "+ ابن"), /*#__PURE__*/React.createElement("span", {
    style: familyMode ? {} : {
      opacity: 0.45
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: familyMode ? () => onAddChild("f") : onUnlock
  }, "+ بنت")), /*#__PURE__*/React.createElement("span", {
    style: familyMode || person.gender === "f" ? {} : {
      opacity: 0.45
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: familyMode || person.gender === "f" ? onAddSpouse : onUnlock
  }, "+ ", person.gender === "f" ? "زوج" : "زوجة"))), !familyMode && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      marginBottom: 10,
      lineHeight: 1.8
    }
  }, "🔒 إضافة الإناث (والدة، بنت، زوجة) تظهر في الوضع العائلي فقط — اضغط أحد الأزرار الباهتة لإدخال رمز العائلة."), familyMode && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement(Btn, {
    C: C,
    active: showSpousePick,
    onClick: () => setShowSpousePick(v => !v)
  }, "⚭ ربط ", person.gender === "f" ? "زوج" : "زوجة", " من الشجرة"), showSpousePick && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      marginBottom: 6,
      lineHeight: 1.7
    }
  }, "للزواج من داخل العائلة: ابحث عن ", person.gender === "f" ? "الزوج" : "الزوجة", " الموجود", person.gender === "f" ? "" : "ة", " في الشجرة بدل إنشاء شخص جديد."), /*#__PURE__*/React.createElement(SpousePicker, {
    C: C,
    people: people,
    person: person,
    edges: edges,
    lineageOf: lineageOf,
    onPick: id => {
      onLinkSpouse(id);
      setShowSpousePick(false);
    }
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: onRadial,
    style: {
      width: "100%",
      padding: "10px",
      borderRadius: 7,
      border: "none",
      background: C.gold,
      color: "#fff",
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 14,
      fontWeight: 600,
      marginBottom: 16
    }
  }, "عرض الفرع دائريًا"), (parents.length > 0 || children.length > 0 || spouses.length > 0) && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.gold,
      marginBottom: 8,
      fontWeight: 700
    }
  }, "الروابط"), parents.map(e => /*#__PURE__*/React.createElement(EdgeRow, {
    key: e.id,
    C: C,
    kind: personOf(e.from)?.gender === "f" ? "والدة" : "والد",
    name: nameOf(e.from),
    onGo: () => onSelect(e.from),
    onDel: () => onRemoveEdge(e.id)
  })), spouses.map(e => {
    const other = e.from === person.id ? e.to : e.from;
    return /*#__PURE__*/React.createElement(EdgeRow, {
      key: e.id,
      C: C,
      kind: personOf(other)?.gender === "f" ? "زوجة" : "زوج",
      name: nameOf(other),
      onGo: () => onSelect(other),
      onDel: () => onRemoveEdge(e.id)
    });
  }), children.map(e => /*#__PURE__*/React.createElement(EdgeRow, {
    key: e.id,
    C: C,
    kind: personOf(e.to)?.gender === "f" ? "ابنة" : "ابن",
    name: nameOf(e.to),
    onGo: () => onSelect(e.to),
    onDel: () => onRemoveEdge(e.id)
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: onDelete,
    style: {
      width: "100%",
      padding: "10px",
      borderRadius: 7,
      border: `1px solid #e3b4ad`,
      background: "transparent",
      color: "#c0392b",
      cursor: "pointer",
      fontFamily: "'Tajawal'",
      fontSize: 14,
      fontWeight: 600
    }
  }, "حذف هذا الشخص"));
}
function EdgeRow({
  C,
  kind,
  name,
  onGo,
  onDel
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "7px 10px",
      background: C.panel2,
      borderRadius: 7,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    onClick: onGo,
    style: {
      cursor: "pointer",
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.sub
    }
  }, kind, ": "), name), /*#__PURE__*/React.createElement("button", {
    onClick: onDel,
    style: {
      background: "transparent",
      border: "none",
      color: "#c0392b",
      cursor: "pointer",
      fontSize: 12
    }
  }, "إزالة الرابط"));
}
function OverlayShell({
  C,
  title,
  onClose,
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      background: C.bg,
      zIndex: 60,
      display: "flex",
      flexDirection: "column"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 18px",
      borderBottom: `1px solid ${C.border}`,
      flexShrink: 0,
      background: "#fff"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Amiri',serif",
      fontSize: 20,
      color: C.gold,
      fontWeight: 700
    }
  }, title), /*#__PURE__*/React.createElement(Btn, {
    C: C,
    onClick: onClose
  }, "عودة للشجرة")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      padding: "18px 16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 720,
      margin: "0 auto"
    }
  }, children)));
}
function StatsOverlay({
  C,
  people,
  edges,
  photos,
  familyMode,
  onClose
}) {
  const sect = {
    fontSize: 15,
    color: C.gold,
    margin: "22px 0 10px",
    fontWeight: 700,
    fontFamily: "'Amiri',serif"
  };
  const deceased = people.filter(p => p.deceased);
  const withPhoto = people.filter(p => photos[p.id]);
  const withDob = people.filter(p => p.dob);
  const males = people.filter(p => p.gender !== "f");
  const females = people.filter(p => p.gender === "f");
  const gens = {};
  people.forEach(p => {
    const g = p.g ?? "؟";
    gens[g] = (gens[g] || 0) + 1;
  });
  const ord = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
  const genRows = Object.entries(gens).sort((a, b) => (a[0] === "؟") - (b[0] === "؟") || a[0] - b[0]);
  const maxGen = Math.max(...genRows.map(([, n]) => n), 1);
  const living = people.filter(p => !p.deceased && ageOf(p) != null).sort((a, b) => ageOf(b) - ageOf(a)).slice(0, 5);
  const today = new Date();
  const upcoming = people.filter(p => {
    if (p.deceased || !p.dob) return false;
    const m = String(p.dob).match(/^\d{4}-(\d{1,2})(?:-(\d{1,2}))?/);
    if (!m) return false;
    const next = new Date(today.getFullYear(), +m[1] - 1, m[2] ? +m[2] : 1);
    if (next < today) next.setFullYear(next.getFullYear() + 1);
    return (next - today) / 86400000 <= 30;
  });
  const tile = {
    background: "#fff",
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: "12px 8px",
    textAlign: "center"
  };
  const num = {
    fontFamily: "'Amiri',serif",
    fontSize: 26,
    fontWeight: 700,
    color: C.gold
  };
  const lbl = {
    fontSize: 12,
    color: C.sub,
    marginTop: 2
  };
  return /*#__PURE__*/React.createElement(OverlayShell, {
    C: C,
    title: "إحصائيات العائلة",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(105px, 1fr))",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: tile
  }, /*#__PURE__*/React.createElement("div", {
    style: num
  }, people.length), /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, "فردًا")), /*#__PURE__*/React.createElement("div", {
    style: tile
  }, /*#__PURE__*/React.createElement("div", {
    style: num
  }, people.length - deceased.length), /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, "على قيد الحياة")), /*#__PURE__*/React.createElement("div", {
    style: tile
  }, /*#__PURE__*/React.createElement("div", {
    style: num
  }, deceased.length), /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, "متوفون")), /*#__PURE__*/React.createElement("div", {
    style: tile
  }, /*#__PURE__*/React.createElement("div", {
    style: num
  }, withPhoto.length), /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, "لديهم صور")), /*#__PURE__*/React.createElement("div", {
    style: tile
  }, /*#__PURE__*/React.createElement("div", {
    style: num
  }, withDob.length), /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, "سُجل ميلادهم")), familyMode && /*#__PURE__*/React.createElement("div", {
    style: tile
  }, /*#__PURE__*/React.createElement("div", {
    style: num
  }, males.length, " / ", females.length), /*#__PURE__*/React.createElement("div", {
    style: lbl
  }, "ذكور / إناث"))), /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "الأفراد في كل جيل"), genRows.map(([g, n]) => /*#__PURE__*/React.createElement("div", {
    key: g,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 90,
      fontSize: 13,
      color: C.parch,
      flexShrink: 0
    }
  }, g === "؟" ? "غير محدد" : `الجيل ${ord[g] || +g + 1}`), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      background: "#eceadf",
      borderRadius: 6,
      height: 20,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${Math.max(3, n / maxGen * 100)}%`,
      height: "100%",
      background: C.goldSoft,
      borderRadius: 6
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 40,
      fontSize: 13,
      color: C.sub,
      textAlign: "left"
    }
  }, n))), familyMode ? /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "أكبر الأحياء سنًا"), living.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub
    }
  }, "لا توجد تواريخ ميلاد مسجلة للأحياء بعد."), living.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    style: {
      display: "flex",
      justifyContent: "space-between",
      padding: "7px 10px",
      background: "#fff",
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      marginBottom: 6,
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("span", null, p.name, p.nickname ? ` (${p.nickname})` : ""), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.gold,
      fontWeight: 700
    }
  }, ageOf(p), " سنة تقريبًا"))), /*#__PURE__*/React.createElement("div", {
    style: sect
  }, "أعياد ميلاد خلال ٣٠ يومًا"), upcoming.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub
    }
  }, "لا أعياد ميلاد قادمة (تُحسب لمن سُجل شهر ميلادهم)."), upcoming.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    style: {
      display: "flex",
      justifyContent: "space-between",
      padding: "7px 10px",
      background: "#fff",
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      marginBottom: 6,
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("span", null, "🎂 ", p.name), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.sub
    }
  }, fmtDate(p.dob))))) : /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 24,
      fontSize: 13,
      color: C.sub,
      background: "#fff",
      border: `1px dashed ${C.border}`,
      borderRadius: 8,
      padding: "10px 12px"
    }
  }, "🔒 إحصائيات الأعمار وأعياد الميلاد والإناث تظهر في الوضع العائلي."));
}
function GalleryOverlay({
  C,
  people,
  photos,
  onClose,
  onOpen
}) {
  const withPhoto = people.filter(p => photos[p.id]);
  return /*#__PURE__*/React.createElement(OverlayShell, {
    C: C,
    title: `معرض صور العائلة (${withPhoto.length})`,
    onClose: onClose
  }, withPhoto.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: C.sub,
      fontSize: 14,
      marginTop: 30
    }
  }, "لا توجد صور بعد."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))",
      gap: 10
    }
  }, withPhoto.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    onClick: () => onOpen(p),
    title: p.name,
    style: {
      cursor: "pointer",
      background: "#fff",
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      overflow: "hidden",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("img", {
    src: photos[p.id],
    alt: p.name,
    loading: "lazy",
    style: {
      width: "100%",
      height: 108,
      objectFit: "cover",
      display: "block"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      padding: "5px 4px",
      color: "#2c2415",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontFamily: "'Tajawal'"
    }
  }, p.name, p.deceased ? " ·" : "")))), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      color: C.sub,
      fontSize: 12,
      marginTop: 14
    }
  }, "اضغط أي صورة للانتقال إلى صاحبها في الشجرة"));
}
(async () => {
  try {
    const r = await fetch('./family-tree-data.json');
    SEED = await r.json();
  } catch (e) {
    console.error('data load failed', e);
  }
  const boot = document.getElementById('boot');
  if (boot) boot.remove();
  ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(FamilyTree, null));
})();