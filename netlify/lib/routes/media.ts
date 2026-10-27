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
const FOLDERS = new Set(["shop-images", "media", "product-images", "testimonials", "offers"]);

/*
 * Admin video uploads. A single base64-in-JSON request tops out around 4.5MB before
 * Netlify's 6MB function payload limit kicks in (base64 adds ~30% overhead) — too small
 * for a 15-60s video. So the browser splits the file into small chunks (see
 * src/lib/videoUpload.ts) and uploads them one at a time; we stash each chunk as its own
 * blob and stitch them together once the last one arrives.
 */
const CHUNK_STORE = "admin-media-video-chunks";
const VIDEO_STORE = "admin-media-video";
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024; // 60MB finished file (well under Blobs' 5GB object cap)
export const MAX_VIDEO_CHUNK_BYTES = 3 * 1024 * 1024; // per chunk, safely under the ~4.5MB effective limit
const VIDEO_FOLDERS = new Set(["product-videos"]);
const VIDEO_TYPES: Record<string, { ext: string[]; mime: string[] }> = {
  mp4: { ext: ["mp4", "m4v"], mime: ["video/mp4", "video/x-m4v"] },
  webm: { ext: ["webm"], mime: ["video/webm"] },
  mov: { ext: ["mov"], mime: ["video/quicktime"] },
};
const SESSION_TTL_MS = 30 * 60 * 1000; // an abandoned upload's chunks are ignored (and prunable) after this

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
export const serveMedia = async (req: Request, key: string) => {
  const isImage = /^[a-z-]+-\d+-[a-f0-9]{12}\.(jpg|png|webp)$/.test(key);
  const isVideo = /^[a-z-]+-\d+-[a-f0-9]{12}\.(mp4|m4v|webm|mov)$/.test(key);
  if (!isImage && !isVideo) throw new HttpError(404, "Not found");

  const { getStore } = await import("@netlify/blobs");
  const store = isVideo ? getStore(VIDEO_STORE) : getStore(STORE);
  const entry = await store.getWithMetadata(key, { type: "arrayBuffer" });
  if (!entry) throw new HttpError(404, "Not found");
  const mime = String((entry.metadata as any)?.contentType ?? "");
  const knownMime = isVideo
    ? Object.values(VIDEO_TYPES).some((t) => t.mime.includes(mime))
    : Object.values(TYPES).some((t) => t.mime === mime);
  if (!knownMime) throw new HttpError(404, "Not found");

  const fullBuffer = Buffer.from(entry.data as ArrayBuffer);
  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": isVideo ? "bytes" : "none",
  };

  // Videos need real range support: Safari/iOS refuses to play (or can't seek)
  // without a 206 response to its Range request.
  const range = isVideo ? req.headers.get("range") : null;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const size = fullBuffer.length;
    if (match) {
      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      const slice = fullBuffer.subarray(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(slice.length),
        },
      });
    }
  }

  return new Response(fullBuffer, { status: 200, headers: baseHeaders });
};

/* ─── Chunked video upload ───
 * start  → POST /api/admin/upload-video/start   { filename, contentType, totalBytes, totalChunks, folder }
 * chunk  → POST /api/admin/upload-video/chunk    { sessionId, index, data }
 * finish → POST /api/admin/upload-video/finish   { sessionId }
 */

const sniffVideo = (b: Buffer): keyof typeof VIDEO_TYPES | null => {
  // MP4 / M4V: ...ftyp at byte offset 4
  if (b.length >= 12 && b.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = b.subarray(8, 12).toString("ascii");
    return brand.startsWith("qt") ? "mov" : "mp4";
  }
  // WebM / Matroska: EBML header
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  // QuickTime .mov (older atom layouts without a leading ftyp)
  if (b.length >= 8 && [...["moov", "mdat", "wide", "free"]].includes(b.subarray(4, 8).toString("ascii"))) return "mov";
  return null;
};

type ChunkSession = {
  filename: string;
  contentType: string;
  totalBytes: number;
  totalChunks: number;
  folder: string;
  createdAt: number;
  adminUid: string;
};

export const startVideoUpload = async (req: Request) => {
  const admin = await requireAdmin(req);
  const body = await readJson(req);

  const totalBytes = Number(body.totalBytes);
  const totalChunks = Number(body.totalChunks);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new HttpError(400, "Invalid file size");
  if (totalBytes > MAX_VIDEO_BYTES) throw new HttpError(400, "Video must be under 60MB");
  if (!Number.isFinite(totalChunks) || totalChunks <= 0 || totalChunks > 500) throw new HttpError(400, "Invalid chunk count");

  const folder = VIDEO_FOLDERS.has(String(body.folder)) ? String(body.folder) : "product-videos";
  const sessionId = crypto.randomBytes(16).toString("hex");
  const session: ChunkSession = {
    filename: String(body.filename ?? ""),
    contentType: String(body.contentType ?? ""),
    totalBytes,
    totalChunks,
    folder,
    createdAt: Date.now(),
    adminUid: admin.uid,
  };

  const { getStore } = await import("@netlify/blobs");
  await getStore(CHUNK_STORE).setJSON(`${sessionId}/session`, session);
  return json(200, { sessionId });
};

export const uploadVideoChunk = async (req: Request) => {
  const admin = await requireAdmin(req);
  const body = await readJson(req);
  const sessionId = String(body.sessionId ?? "");
  const index = Number(body.index);
  if (!/^[a-f0-9]{32}$/.test(sessionId)) throw new HttpError(400, "Invalid session");

  const { getStore } = await import("@netlify/blobs");
  const chunkStore = getStore(CHUNK_STORE);
  const session = await chunkStore.get(`${sessionId}/session`, { type: "json" }) as ChunkSession | null;
  if (!session) throw new HttpError(404, "Upload session not found or expired");
  if (session.adminUid !== admin.uid) throw new HttpError(403, "Not your upload session");
  if (Date.now() - session.createdAt > SESSION_TTL_MS) throw new HttpError(410, "Upload session expired, please retry");
  if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) throw new HttpError(400, "Invalid chunk index");

  const raw = String(body.data ?? "");
  const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw new HttpError(400, "Invalid chunk data");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_VIDEO_CHUNK_BYTES + 1024) throw new HttpError(400, "Chunk too large");

  await chunkStore.set(`${sessionId}/chunk-${index}`, new Blob([bytes]));
  return json(200, { success: true, index });
};

export const finishVideoUpload = async (req: Request) => {
  const admin = await requireAdmin(req);
  const body = await readJson(req);
  const sessionId = String(body.sessionId ?? "");
  if (!/^[a-f0-9]{32}$/.test(sessionId)) throw new HttpError(400, "Invalid session");

  const { getStore } = await import("@netlify/blobs");
  const chunkStore = getStore(CHUNK_STORE);
  const session = await chunkStore.get(`${sessionId}/session`, { type: "json" }) as ChunkSession | null;
  if (!session) throw new HttpError(404, "Upload session not found or expired");
  if (session.adminUid !== admin.uid) throw new HttpError(403, "Not your upload session");

  const parts: Buffer[] = [];
  for (let i = 0; i < session.totalChunks; i++) {
    const chunk = await chunkStore.get(`${sessionId}/chunk-${i}`, { type: "arrayBuffer" });
    if (!chunk) throw new HttpError(400, `Missing chunk ${i} — please retry the upload`);
    parts.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(parts);

  if (bytes.length !== session.totalBytes) {
    throw new HttpError(400, "Uploaded video is incomplete or corrupted — please retry");
  }
  if (bytes.length > MAX_VIDEO_BYTES) throw new HttpError(400, "Video must be under 60MB");

  const kind = sniffVideo(bytes);
  const spec = kind ? VIDEO_TYPES[kind] : null;
  const ext = String(session.filename).toLowerCase().split(".").pop() ?? "";
  const mime = session.contentType.toLowerCase();
  if (!spec || !spec.ext.includes(ext) || !spec.mime.includes(mime)) {
    throw new HttpError(400, "Only MP4, WebM or MOV videos are allowed");
  }

  const key = `${session.folder}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${spec.ext[0]}`;
  const { getStore: getStoreForVideo } = await import("@netlify/blobs");
  await getStoreForVideo(VIDEO_STORE).set(key, new Blob([bytes], { type: spec.mime[0] }), {
    metadata: { contentType: spec.mime[0] },
  });

  // Best-effort cleanup of the temporary chunks; the finished video is what matters.
  await Promise.allSettled([
    chunkStore.delete(`${sessionId}/session`),
    ...Array.from({ length: session.totalChunks }, (_, i) => chunkStore.delete(`${sessionId}/chunk-${i}`)),
  ]);

  return json(200, { success: true, url: `/api/media/${key}`, key });
};
