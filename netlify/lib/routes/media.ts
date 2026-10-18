import crypto from "node:crypto";
import { requireAdmin } from "../auth";
import { HttpError, json, readJson } from "../http";

/*
 * Admin image uploads, stored in Netlify Blobs (free on the existing Netlify site) and served
 * from /api/media/<key>. Images only: extension, declared MIME type and the file's own
 * signature must all agree, so an .html/.svg/.js file can never be stored or served.
 */

const STORE = "admin-media";
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // keeps the base64 request under Netlify's 6 MB limit
const FOLDERS = new Set(["shop-images", "media", "product-images", "testimonials"]);

const TYPES: Record<string, { ext: string[]; mime: string }> = {
  jpeg: { ext: ["jpg", "jpeg"], mime: "image/jpeg" },
  png: { ext: ["png"], mime: "image/png" },
  webp: { ext: ["webp"], mime: "image/webp" },
};

const sniff = (b: Buffer): keyof typeof TYPES | null => {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
};

/** Returns the canonical extension and MIME type, or throws a 400. */
export const validateImage = (bytes: Buffer, filename: unknown, contentType: unknown) => {
  if (bytes.length === 0) throw new HttpError(400, "The file is empty");
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(400, "Image must be under 4 MB");

  const ext = String(filename ?? "").toLowerCase().split(".").pop() ?? "";
  const mime = String(contentType ?? "").toLowerCase();
  const kind = sniff(bytes);
  const spec = kind ? TYPES[kind] : null;
  if (!spec || !spec.ext.includes(ext) || mime !== spec.mime) {
    throw new HttpError(400, "Only JPG, PNG or WebP images are allowed");
  }
  return { ext: spec.ext[0], mime: spec.mime };
};

/* ─── POST /api/admin/upload-media ─── */
export const uploadMedia = async (req: Request) => {
  await requireAdmin(req);
  const body = await readJson(req);
  const raw = String(body.data ?? "");
  const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw new HttpError(400, "Invalid file data");

  const bytes = Buffer.from(base64, "base64");
  const { ext, mime } = validateImage(bytes, body.filename, body.contentType);
  const folder = FOLDERS.has(String(body.folder)) ? String(body.folder) : "media";
  const key = `${folder}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;

  const { getStore } = await import("@netlify/blobs");
  await getStore(STORE).set(key, new Blob([bytes], { type: mime }), { metadata: { contentType: mime } });
  return json(200, { success: true, url: `/api/media/${key}`, key });
};

/* ─── GET /api/media/:key (public) ─── */
export const serveMedia = async (_req: Request, key: string) => {
  if (!/^[a-z-]+-\d+-[a-f0-9]{12}\.(jpg|png|webp)$/.test(key)) throw new HttpError(404, "Not found");
  const { getStore } = await import("@netlify/blobs");
  const entry = await getStore(STORE).getWithMetadata(key, { type: "arrayBuffer" });
  if (!entry) throw new HttpError(404, "Not found");
  const mime = String((entry.metadata as any)?.contentType ?? "");
  if (!Object.values(TYPES).some((t) => t.mime === mime)) throw new HttpError(404, "Not found");
  return new Response(entry.data, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
