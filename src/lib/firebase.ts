import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { initializeFirestore, getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import baseConfig from "../../firebase-applet-config.json";

// Web config of the astro-with-hrishi Firebase web app (firebase-applet-config.json).
// Optional VITE_FIREBASE_* variables override it, for example the emulator project in local development.
const getActiveConfig = () => {
  const env = import.meta.env;
  return {
    projectId: env.VITE_FIREBASE_PROJECT_ID || baseConfig.projectId,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || baseConfig.authDomain,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || baseConfig.storageBucket,
    apiKey: env.VITE_FIREBASE_API_KEY || baseConfig.apiKey,
    appId: env.VITE_FIREBASE_APP_ID || baseConfig.appId,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || baseConfig.messagingSenderId,
    measurementId: env.VITE_GA_MEASUREMENT_ID || baseConfig.measurementId,
  };
};

const activeConfig = getActiveConfig();
const app = !getApps().length ? initializeApp(activeConfig) : getApp();

export const auth = getAuth(app);

// Initialize Firestore with auto-detect long polling and ignore undefined properties
export const db = (() => {
  const configured = baseConfig.firestoreDatabaseId;
  const databaseId = configured && configured !== "(default)" ? configured : undefined;

  if (typeof window !== "undefined") {
    try {
      return initializeFirestore(app, {
        experimentalAutoDetectLongPolling: true,
        ignoreUndefinedProperties: true,
      }, databaseId);
    } catch {
      return databaseId ? getFirestore(app, databaseId) : getFirestore(app);
    }
  }

  return databaseId ? getFirestore(app, databaseId) : getFirestore(app);
})();

export const storage = getStorage(app);

// Local development only: route Auth and Firestore to the Firebase Emulator Suite.
if (import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATOR === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

export default app;
