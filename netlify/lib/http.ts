/** Error with an HTTP status; `message` is safe to show to the client. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Server misconfiguration (missing env var etc.). Details are logged, never returned. */
export class ConfigError extends Error {}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const readJson = async (req: Request): Promise<Record<string, any>> => {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
};

export const bearerToken = (req: Request): string | null => {
  const header = req.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
};

/** Converts any thrown value into a JSON error response. */
export const errorResponse = (err: unknown) => {
  if (err instanceof HttpError) return json(err.status, { error: err.message });
  if (err instanceof ConfigError) {
    console.error("[config]", err.message);
    return json(500, { error: "Server configuration error" });
  }
  console.error("[api] unhandled error:", err);
  return json(500, { error: "Internal server error" });
};
