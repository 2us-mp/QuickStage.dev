/**
 * OAuth middleware for QuickStage.
 *
 * Frontend must send:
 *   Authorization: Bearer <token>
 *
 * This backend validates by calling your OAuth "me" endpoint.
 *
 * Required env:
 *   OAUTH_ME_URL   e.g. https://quick-stage.app/api/auth/me
 */
export async function requireAuth(req, res, next) {
  try {
    const user = await validateToken(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    req.user = user;
    next();
  } catch (e) {
    console.error("Auth error:", e);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

async function validateToken(req) {
  const meUrl = process.env.OAUTH_ME_URL;
  if (!meUrl) throw new Error("OAUTH_ME_URL is missing.");

  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const token = m[1].trim();
  const timeout = Number(process.env.OAUTH_TIMEOUT_MS || "5000");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);

  const resp = await fetch(meUrl, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` },
    signal: controller.signal
  }).finally(() => clearTimeout(t));

  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data || (!data.id && !data.email)) return null;
  return data;
}
