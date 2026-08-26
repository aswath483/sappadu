// Cloud sync for Sappadu — mirrors the same architecture used in the workout
// app's lib/firebase.ts + lib/cloudSync.ts: one Firestore document per profile
// (Aswath and Surekaa sync independently, never seeing each other's data),
// anonymous auth just to satisfy Firestore security rules, and a debounced
// "snapshot everything under this profile's prefix, push it" sync.
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

// A collection separate from the workout app's `appState` — in case the same
// Firebase project ends up backing both apps, a shared collection name would
// otherwise let Sappadu's per-profile docs collide with the workout app's.
const COLLECTION = 'sappaduState';
// Never synced: the migXxx one-time-migration flags (local bookkeeping, not
// data), 'aiKey' (a personal Anthropic API credential that should never leave
// the device it was entered on), and the sync bookkeeping key itself.
const EXCLUDED_SUFFIXES = new Set(['aiKey', 'aiModel', 'migWaterMl']);

function lastSyncedKey(prefix) { return `${prefix}cloud_last_synced_at`; }

function snapshotLocal(prefix) {
  const snap = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(prefix)) continue;
    const suffix = k.slice(prefix.length);
    if (suffix === 'cloud_last_synced_at' || EXCLUDED_SUFFIXES.has(suffix)) continue;
    const v = localStorage.getItem(k);
    if (v !== null) snap[k] = v;
  }
  return snap;
}

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

const pushTimers = new Map(); // prefix -> timer
const applyingRemote = new Set(); // prefixes currently being written by a pull, to avoid echoing straight back up

function schedulePush(profileId, prefix) {
  if (applyingRemote.has(prefix)) return;
  clearTimeout(pushTimers.get(prefix));
  pushTimers.set(prefix, setTimeout(() => pushNow(profileId, prefix), 1500));
}

async function pushNow(profileId, prefix) {
  if (!(await ensureInit())) return;
  await authReady;
  const { doc, setDoc, serverTimestamp } = fns;
  try {
    await setDoc(doc(db, COLLECTION, profileId), { data: snapshotLocal(prefix), updatedAt: serverTimestamp() });
    localStorage.setItem(lastSyncedKey(prefix), String(Date.now()));
  } catch (e) { console.warn('[sappadu-sync] push failed', e); }
}

// Call once at startup, before the first render — pulls the given profile's
// latest cloud snapshot into localStorage if it's newer than what's already
// here. Only ever touches that one profile's own document/prefix.
export async function pullProfile(profileId, prefix) {
  if (!(await ensureInit())) return;
  await authReady;
  const { doc, getDoc } = fns;
  try {
    const snap = await getDoc(doc(db, COLLECTION, profileId));
    if (!snap.exists()) { await pushNow(profileId, prefix); return; } // nothing in the cloud yet — seed it
    const remote = snap.data();
    const remoteMs = remote.updatedAt?.toMillis() ?? 0;
    const localMs = Number(localStorage.getItem(lastSyncedKey(prefix)) || 0);
    if (remoteMs <= localMs) return;
    applyingRemote.add(prefix);
    for (const [k, v] of Object.entries(remote.data || {})) localStorage.setItem(k, v);
    localStorage.setItem(lastSyncedKey(prefix), String(remoteMs));
    applyingRemote.delete(prefix);
  } catch (e) { console.warn('[sappadu-sync] pull failed', e); }
}

const writablePrefixes = new Map(); // prefix -> profileId
let patched = false;

// Call once at startup — patches localStorage so any future write under this
// profile's prefix gets pushed to its own cloud document automatically
// (debounced). Safe to call for only the currently-active profile; the other
// profile's data on this device (if any, from a previous switch) is never
// watched or pushed until someone actually switches back to it.
export function watchProfile(profileId, prefix) {
  if (!isFirebaseConfigured) return;
  writablePrefixes.set(prefix, profileId);
  if (patched) return;
  patched = true;
  const rawSet = localStorage.setItem.bind(localStorage);
  const rawRemove = localStorage.removeItem.bind(localStorage);
  const maybeSchedule = (k) => {
    for (const [prefix, profileId] of writablePrefixes) {
      if (k.startsWith(prefix) && k !== lastSyncedKey(prefix)) schedulePush(profileId, prefix);
    }
  };
  localStorage.setItem = (k, v) => { rawSet(k, v); maybeSchedule(k); };
  localStorage.removeItem = (k) => { rawRemove(k); maybeSchedule(k); };
}
