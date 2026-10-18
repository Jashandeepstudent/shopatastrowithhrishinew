import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { cert } from "firebase-admin/app";
import { normalizePrivateKey } from "../lib/firebaseAdmin";

/* FIREBASE_PRIVATE_KEY is pasted by hand into the Netlify screen. It must work however it arrives. */

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString(); // real line breaks
const original = pem.trim();

const variants: Record<string, string> = {
  "real line breaks (pasted as is)": pem,
  "real line breaks, no final newline": original,
  "\\n sequences on one line (as in the JSON file)": original.replace(/\n/g, "\\n"),
  "\\n sequences with trailing \\n": pem.replace(/\n/g, "\\n"),
  "wrapped in double quotes": `"${original.replace(/\n/g, "\\n")}"`,
  "wrapped in single quotes": `'${original.replace(/\n/g, "\\n")}'`,
  "Windows line endings": original.replace(/\n/g, "\r\n"),
  "line breaks turned into spaces": original.replace(/\n/g, " "),
  "extra spaces and blank lines around it": `\n\n   ${original}   \n\n`,
  "literal \\r\\n sequences": original.replace(/\n/g, "\\r\\n"),
};

describe("normalizePrivateKey", () => {
  for (const [name, value] of Object.entries(variants)) {
    it(`accepts: ${name}`, () => {
      const out = normalizePrivateKey(value);
      expect(out).toBe(pem); // identical to the original key, byte for byte
      expect(() => crypto.createPrivateKey(out!)).not.toThrow(); // a usable key
      expect(() => cert({ projectId: "p", clientEmail: "a@b.iam.gserviceaccount.com", privateKey: out! })).not.toThrow();
    });
  }

  it("rejects values that are not a private key", () => {
    for (const bad of ["", undefined, null, "hello", "-----BEGIN PRIVATE KEY----- not base64 !!! -----END PRIVATE KEY-----", '{"type":"service_account"}']) {
      expect(normalizePrivateKey(bad as any)).toBeNull();
    }
  });
});
