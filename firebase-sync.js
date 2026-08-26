// Cloud sync for Sappadu — mirrors the same architecture used in the workout
// app's lib/firebase.ts + lib/cloudSync.ts, adapted for a build-step-free
// vanilla app: one shared Firestore document (Sappadu has no per-person
// profile split, unlike the workout app), anonymous auth just to satisfy
// Firestore security rules, and a debounced "snapshot everything, push it"
// sync — simple and easy to reason about for a single-user food log.
import { firebaseConfig } from './firebase-config.js';

export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

// The Firebase SDK itself is loaded lazily (dynamic import, only from inside
// ensureInit) rather than as a static top-level import. Sappadu is an
// offline-first PWA — a static import of a CDN URL runs unconditionally at
// module-load time, and would try to fetch gstatic.com (and fail the whole
// module, taking the rest of the app down with it) even for a user who never
// configures Firebase, or who's offline. Lazy-loading means zero network
// calls happen at all until isFirebaseConfigured is actually true.
let sdk = null;
async function loadSdk() {
  if (sdk) return sdk;
  const [{ initializeApp }, { getAuth, onAuthStateChanged, signInAnonymously }, { initializeFirestore, doc, getDoc, setDoc, serverTimestamp }] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'),
  ]);
  sdk = { initializeApp, getAuth, onAuthStateChanged, signInAnonymously, initializeFirestore, doc, getDoc, setDoc, serverTimestamp };
  return sdk;
}

// One well-known document — every device running Sappadu reads/writes the
// same place, which is what makes this app usable across your own phone,
// tablet, etc. Anonymous auth here is only to satisfy Firestore's security
// rules (see firestore.rules); it does not partition the data.
const DOC_PATH = ['appState', 'sappadu'];
const LAST_SYNCED_KEY = '__cloudLastSyncedAt';
// Deliberately excludes 'aiKey' (a personal Anthropic API credential that should
// never leave the device it was entered on) and the migXxx one-time-migration
// flags (local bookkeeping, not data — each device runs its own migrations
// against whatever data it has, rather than inheriting "already migrated"
// from a device that got there first).
const SYNC_KEYS = ['profile','days','weights','customFoods','favs','freq','recent','dietPref','reminders','theme'];

let db = null, authReady = null, fns = null;

async function ensureInit() {
  if (!isFirebaseConfigured) return null;
  if (db) return db;
  const { initializeApp, getAuth, onAuthStateChanged, signInAnonymously, initializeFirestore, doc, getDoc, setDoc, serverTimestamp } = await loadSdk();
  fns = { doc, getDoc, setDoc, serverTimestamp };
  const app = initializeApp(firebaseConfig);
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  const auth = getAuth(app);
  authReady = new Promise((resolve) => {
    onAuthStateChanged(auth, (user) => {
      if (user) resolve(user.uid);
      else signInAnonymously(auth).catch(() => resolve(null));
    });
  });
  return db;
}

function snapshotLocal() {
  const snap = {};
  for (const k of SYNC_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) snap[k] = v;
  }
  return snap;
}

let pushTimer = null;
let applyingRemote = false;
function schedulePush() {
  if (!isFirebaseConfigured || applyingRemote) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}
async function pushNow() {
  if (!(await ensureInit())) return;
  await authReady;
  const { doc, setDoc, serverTimestamp } = fns;
  try {
    await setDoc(doc(db, ...DOC_PATH), { data: snapshotLocal(), updatedAt: serverTimestamp() });
    localStorage.setItem(LAST_SYNCED_KEY, String(Date.now()));
  } catch (e) { console.warn('[sappadu-sync] push failed', e); }
}

// Call once at startup, before the first render — pulls the latest cloud
// snapshot into localStorage if it's newer than what's already here.
export async function pullOnce() {
  if (!(await ensureInit())) return;
  await authReady;
  const { doc, getDoc } = fns;
  try {
    const snap = await getDoc(doc(db, ...DOC_PATH));
    if (!snap.exists()) { await pushNow(); return; } // nothing in the cloud yet — seed it
    const remote = snap.data();
    const remoteMs = remote.updatedAt?.toMillis() ?? 0;
    const localMs = Number(localStorage.getItem(LAST_SYNCED_KEY) || 0);
    if (remoteMs <= localMs) return;
    applyingRemote = true;
    for (const [k, v] of Object.entries(remote.data || {})) localStorage.setItem(k, v);
    localStorage.setItem(LAST_SYNCED_KEY, String(remoteMs));
    applyingRemote = false;
  } catch (e) { console.warn('[sappadu-sync] pull failed', e); }
}

// Call once at startup — patches localStorage so any future write to a
// synced key gets pushed to the cloud automatically (debounced).
let patched = false;
export function watchLocalStorage() {
  if (!isFirebaseConfigured || patched) return;
  patched = true;
  const rawSet = localStorage.setItem.bind(localStorage);
  const rawRemove = localStorage.removeItem.bind(localStorage);
  localStorage.setItem = (k, v) => { rawSet(k, v); if (SYNC_KEYS.includes(k)) schedulePush(); };
  localStorage.removeItem = (k) => { rawRemove(k); if (SYNC_KEYS.includes(k)) schedulePush(); };
}
