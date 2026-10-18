// Creates (or promotes) an admin account in Firebase Auth and gives it the `admin` claim.
//
// Usage (real project, credentials in the environment, never typed into chat):
//   node --env-file=.env.admin scripts/create-admin.mjs owner@example.com
// Optional: ADMIN_PASSWORD=... to choose the password. Otherwise a strong one is generated and
// printed once. Re-running for an existing email keeps the account and just (re)applies the claim.
//
// Needed env vars: VITE_FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// For the local emulator: FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 and the project id only.

import crypto from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const email = (process.argv[2] || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: node scripts/create-admin.mjs <admin-email>");
  process.exit(1);
}

const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
if (!projectId) {
  console.error("VITE_FIREBASE_PROJECT_ID is not set.");
  process.exit(1);
}

const emulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
if (emulator) {
  initializeApp({ projectId });
} else {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) {
    console.error("FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set.");
    process.exit(1);
  }
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
}

const auth = getAuth();
let generated = null;

let user;
try {
  user = await auth.getUserByEmail(email);
  console.log(`Account already exists: ${user.uid}`);
} catch (err) {
  if (err?.code !== "auth/user-not-found") throw err;
  const password = process.env.ADMIN_PASSWORD || (generated = crypto.randomBytes(12).toString("base64url") + "9aA!");
  if (password.length < 10) {
    console.error("ADMIN_PASSWORD must be at least 10 characters.");
    process.exit(1);
  }
  user = await auth.createUser({ email, password, emailVerified: true, displayName: "Admin" });
  console.log(`Created account: ${user.uid}`);
}

await auth.setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true });
console.log(`Admin claim set for ${email}. Sign in at /admin/login.`);
if (generated) console.log(`One-time password (change it after first sign-in): ${generated}`);
console.log(`UID (for ADMIN_UIDS, optional): ${user.uid}`);
