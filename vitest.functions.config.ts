import { defineConfig } from "vitest/config";

// Backend (Netlify Functions) tests. Needs the Firebase emulators running: `npm run emulators`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["netlify/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      VITE_FIREBASE_PROJECT_ID: "demo-astro-hrishi",
      RAZORPAY_KEY_ID: "rzp_test_UnitTestKey01",
      RAZORPAY_KEY_SECRET: "unit_test_key_secret",
      RAZORPAY_WEBHOOK_SECRET: "unit_test_webhook_secret",
      ADMIN_UIDS: "",
    },
  },
});
