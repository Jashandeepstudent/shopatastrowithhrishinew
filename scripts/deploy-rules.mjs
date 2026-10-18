// Deploys firestore.rules to the default Firestore database through the Firebase Rules API.
// Same effect as `firebase deploy --only firestore:rules`, for service accounts that cannot call Service Usage.
//
//   node --env-file=.env.admin scripts/deploy-rules.mjs [--dry-run]
//
// STOP: this changes the real project's security rules (go-live step). Prints a before/after comparison.

import fs from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";

const dry = process.argv.includes("--dry-run");
const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
if (!projectId || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
  console.error("Missing VITE_FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (use --env-file=.env.admin).");
  process.exit(1);
}
const app = initializeApp({ credential: cert({ projectId, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey }), projectId });
const token = (await app.options.credential.getAccessToken()).access_token;
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const api = `https://firebaserules.googleapis.com/v1/projects/${projectId}`;
const content = fs.readFileSync("firestore.rules", "utf8").replace(/\r\n/g, "\n");

const current = async () => {
  const rel = await (await fetch(`${api}/releases/cloud.firestore`, { headers: H })).json();
  if (rel.error) return { error: rel.error.message };
  const rs = await (await fetch(`https://firebaserules.googleapis.com/v1/${rel.rulesetName}`, { headers: H })).json();
  return { rulesetName: rel.rulesetName, updateTime: rel.updateTime, content: (rs.source?.files || []).map((f) => f.content).join("\n") };
};

const before = await current();
console.log(`Project ${projectId}, database (default)`);
console.log("Before:", before.error || `${before.content.length} chars, released ${before.updateTime}`);

if (dry) {
  console.log("Dry run: would release the local firestore.rules (" + content.length + " chars).");
  process.exit(0);
}

const created = await fetch(`${api}/rulesets`, { method: "POST", headers: H, body: JSON.stringify({ source: { files: [{ name: "firestore.rules", content }] } }) });
const cj = await created.json();
if (!created.ok) {
  console.error("Ruleset rejected:", cj.error?.message || created.status);
  process.exit(1);
}
const rel = await fetch(`${api}/releases/cloud.firestore`, {
  method: "PATCH", headers: H,
  body: JSON.stringify({ release: { name: `projects/${projectId}/releases/cloud.firestore`, rulesetName: cj.name } }),
});
const rj = await rel.json();
if (!rel.ok) {
  console.error("Release failed:", rj.error?.message || rel.status);
  process.exit(1);
}
const after = await current();
console.log("After: ", after.error || `${after.content.length} chars, released ${after.updateTime}`);
console.log("Deployed rules match firestore.rules:", after.content.trim() === content.trim());
