import type { DecodedIdToken } from "firebase-admin/auth";
import { getAdminAuth } from "./firebaseAdmin";
import { HttpError, bearerToken } from "./http";

/**
 * Verifies a Firebase ID token (signature, expiry, project) with the Admin SDK.
 * Returns null when no token is sent; throws 401 when a token is sent but invalid.
 */
export const optionalUser = async (req: Request): Promise<DecodedIdToken | null> => {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    return await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new HttpError(401, "Your session has expired. Please sign in again.");
  }
};

const adminUids = () =>
  (process.env.ADMIN_UIDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const isAdminToken = (user: DecodedIdToken) => user.admin === true || adminUids().includes(user.uid);

/** Admin = verified Firebase user with custom claim `admin: true` or a UID listed in ADMIN_UIDS. */
export const requireAdmin = async (req: Request): Promise<DecodedIdToken> => {
  const user = await optionalUser(req);
  if (!user) throw new HttpError(401, "Admin sign-in required");
  if (!isAdminToken(user)) throw new HttpError(403, "Admin access required");
  return user;
};
