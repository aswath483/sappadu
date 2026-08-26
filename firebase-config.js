// Firebase project settings — console.firebase.google.com → Project settings
// → General → Your apps → SDK setup.
//
// This file is loaded as plain JS (no build step), so these values are visible
// to anyone who opens the app in a browser — that's expected for a Firebase
// *client* config, it is not a secret. What actually protects your data is the
// Firestore security rules (see firestore.rules in this repo) — make sure
// that's pasted into the Firebase console (Firestore Database → Rules) and
// that Authentication → Sign-in method → Anonymous is enabled, since
// firebase-sync.js signs in anonymously just to satisfy those rules.
//
// No measurementId/Analytics here — firebase-sync.js only uses Auth and
// Firestore, so there's no reason to pull in and initialize the Analytics SDK.
export const firebaseConfig = {
  apiKey: "AIzaSyDxooPtEPf4PsILQsU7GVtuO681oS4lh9w",
  authDomain: "sappadu-ae9c6.firebaseapp.com",
  projectId: "sappadu-ae9c6",
  storageBucket: "sappadu-ae9c6.firebasestorage.app",
  messagingSenderId: "203188821431",
  appId: "1:203188821431:web:147636bacfeb7512f89c32",
};
