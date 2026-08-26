// Fill these in from your Firebase project settings:
// console.firebase.google.com → Project settings → General → Your apps → SDK setup
//
// Leave apiKey/projectId empty and Sappadu just runs local-only, exactly as it
// does today — nothing else changes until you add real values here.
//
// This file is loaded as plain JS (no build step), so these values are visible
// to anyone who opens the app in a browser — that's expected for a Firebase
// *client* config, it is not a secret. What actually protects your data is the
// Firestore security rules (see firestore.rules in this repo).
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};
