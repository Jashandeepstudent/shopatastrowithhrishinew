import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { ConfigError } from "./http";

/*
 * Credentials come from three env vars only (keeps Netlify's 4 KB env limit):
 *   VITE_FIREBASE_PROJECT_ID (shared with the frontend), FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
 * Local development uses the Firebase emulators via FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST.
 */

let app: App | null = null;

/**
 * Accepts FIREBASE_PRIVATE_KEY however it was pasted into Netlify: real line breaks, "\\n" sequences,
 * wrapped in quotes, Windows line endings, or collapsed onto one line with spaces. Returns a clean PEM,
 * or null when the value is not a private key at all.
 */
export const normalizePrivateKey = (raw: string | undefined | null): string | null => {
  if (!raw) return null;
  let text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1);
  const m = text.match(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!m) return null;
  const body = m[2].replace(/\\r|\\n/g, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) return null;
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END ${m[1]}-----\n`;
};

const usingEmulators = () =>
  Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);

const initApp = (): App => {
  if (app) return app;
  if (getApps().length) return (app = getApps()[0]);

  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
  if (!projectId) throw new ConfigError("VITE_FIREBASE_PROJECT_ID is not set");

  if (usingEmulators()) {
    // The Auth emulator accepts unsigned tokens, so emulator mode must never run in a deployed site.
    if (process.env.NETLIFY_DEV !== "true" && process.env.NODE_ENV !== "test") {
      throw new ConfigError("Firebase emulator variables are set outside local development");
    }
    return (app = initializeApp({ projectId }));
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!clientEmail || !rawKey) {
    throw new ConfigError("FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be set");
  }
  const privateKey = normalizePrivateKey(rawKey);
  if (!privateKey) throw new ConfigError("FIREBASE_PRIVATE_KEY is not a valid private key (paste the private_key value from the service account file)");
  return (app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId }));
};

let db: Firestore | null = null;

export const getDb = (): Firestore => {
  if (db) return db;
  db = getFirestore(initApp());
  db.settings({ ignoreUndefinedProperties: true });
  return db;
};

export const getAdminAuth = (): Auth => getAuth(initApp());
