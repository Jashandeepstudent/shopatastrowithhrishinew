import crypto from "node:crypto";
import Razorpay from "razorpay";
import { ConfigError } from "./http";

/** Razorpay credentials come only from env vars; nothing is read from Firestore or files. */
const credentials = () => {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) throw new ConfigError("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set");
  return { keyId, keySecret };
};

let client: Razorpay | null = null;

export const getRazorpay = (): Razorpay => {
  if (client) return client;
  const { keyId, keySecret } = credentials();
  return (client = new Razorpay({ key_id: keyId, key_secret: keySecret }));
};

/**
 * The Razorpay SDK has no request timeout; Netlify stops synchronous functions after ~10 s.
 * Fail cleanly first so the caller can return a proper error.
 */
export const gateway = <T>(call: Promise<T>, ms = 8000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Razorpay request timed out"), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
};

/** The public key ID, safe to send to the browser. */
export const publicKeyId = () => credentials().keyId;

const hmacHex = (secret: string, payload: string) =>
  crypto.createHmac("sha256", secret).update(payload).digest("hex");

const safeEqualHex = (expected: string, received: unknown) => {
  if (typeof received !== "string" || !/^[0-9a-f]+$/i.test(received)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Checkout success callback signature: HMAC-SHA256("<order_id>|<payment_id>", key secret). */
export const verifyCheckoutSignature = (razorpayOrderId: string, paymentId: string, signature: unknown) =>
  safeEqualHex(hmacHex(credentials().keySecret, `${razorpayOrderId}|${paymentId}`), signature);

/** Webhook signature: HMAC-SHA256(raw request body, webhook secret). */
export const verifyWebhookSignature = (rawBody: string, signature: unknown) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  if (!secret) throw new ConfigError("RAZORPAY_WEBHOOK_SECRET is not set");
  return safeEqualHex(hmacHex(secret, rawBody), signature);
};

export const isRazorpayId = (prefix: "order" | "pay", value: unknown): value is string =>
  typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9]{10,20}$`).test(value);
