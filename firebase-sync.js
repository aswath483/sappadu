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
  // Everything here can fail on a bad connection (the dynamic SDK imports
  // fetch from gstatic.com, initializeApp/Firestore can throw on a malformed
  // config) — caught so a network hiccup returns null (every caller already
  // treats that as "sync unavailable right now") instead of throwing out of
  // ensureInit uncaught, which would otherwise reject the pullProfile() call
  // the app bootstrap races at startup and skip every line after it —
  // including render() — leaving a blank screen.
  try {
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
  } catch (e) {
    console.warn('[sappadu-sync] init failed', e);
    db = null;
    return null;
  }
}

const pushTimers = new Map(); // prefix -> timer
const applyingRemote = new Set(); // prefixes currently being written by a pull, to avoid echoing straight back up

function schedulePush(profileId, prefix) {
  if (applyingRemote.has(prefix)) return;
  clearTimeout(pushTimers.get(prefix));
  pushTimers.set(prefix, setTimeout(() => pushNow(profileId, prefix), 1500));
}

async function pushNow(profileId, prefix) {
  if (!(await ensureInit())) return false;
  await authReady;
  const { doc, setDoc, serverTimestamp } = fns;
  try {
    await setDoc(doc(db, COLLECTION, profileId), { data: snapshotLocal(prefix), updatedAt: serverTimestamp() });
    localStorage.setItem(lastSyncedKey(prefix), String(Date.now()));
    return true;
  } catch (e) { console.warn('[sappadu-sync] push failed', e); return false; }
}

// Call once at startup, before the first render — pulls the given profile's
// latest cloud snapshot into localStorage if it's newer than what's already
// here. Only ever touches that one profile's own document/prefix.
export async function pullProfile(profileId, prefix) {
  if (!(await ensureInit())) return false;
  await authReady;
  const { doc, getDoc } = fns;
  try {
    const snap = await getDoc(doc(db, COLLECTION, profileId));
    if (!snap.exists()) return await pushNow(profileId, prefix); // nothing in the cloud yet — seed it
    const remote = snap.data();
    const remoteMs = remote.updatedAt?.toMillis() ?? 0;
    const localMs = Number(localStorage.getItem(lastSyncedKey(prefix)) || 0);
    if (remoteMs <= localMs) return true;
    applyingRemote.add(prefix);
    for (const [k, v] of Object.entries(remote.data || {})) localStorage.setItem(k, v);
    localStorage.setItem(lastSyncedKey(prefix), String(remoteMs));
    applyingRemote.delete(prefix);
    return true;
  } catch (e) { console.warn('[sappadu-sync] pull failed', e); return false; }
}

// Manual sync trigger for a "Sync now" button — pushes current local state
// immediately (bypassing the usual 1.5s debounce) then pulls in case the
// cloud has something newer. Returns whether it actually succeeded, so the
// caller can show a real success/failure state instead of guessing from timing.
export async function syncNow(profileId, prefix) {
  const pushed = await pushNow(profileId, prefix);
  const pulled = await pullProfile(profileId, prefix);
  return pushed && pulled;
}

// Read-only look at another profile's cloud document — never writes anything,
// never touches localStorage, and doesn't seed the doc if it's missing (unlike
// pullProfile, which is allowed to seed since it's only ever called for your
// own active profile). Used for couple-facing features like comparing today's
// progress, where you want the other profile's data without switching
// identity or risking overwriting theirs from a stale local copy.
export async function peekProfile(profileId) {
  if (!(await ensureInit())) return null;
  await authReady;
  const { doc, getDoc } = fns;
  try {
    const snap = await getDoc(doc(db, COLLECTION, profileId));
    if (!snap.exists()) return null;
    return (snap.data() || {}).data || null;
  } catch (e) { console.warn('[sappadu-sync] peek failed', e); return null; }
}

// Snapshot of where sync stands for this profile, for a small status line in
// the UI. Synchronous/cheap — meant to be read fresh on each render rather
// than subscribed to.
export function syncStatus(prefix) {
  if (!isFirebaseConfigured) return null;
  const lastSyncedAt = Number(localStorage.getItem(lastSyncedKey(prefix)) || 0) || null;
  return { online: navigator.onLine, pending: pushTimers.has(prefix), lastSyncedAt };
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
