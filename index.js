import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { lookupContentType } from "./lib/contentType.js";
import { requireAuth } from "./lib/oauthAuth.js";
import { dohLookup } from "./lib/dns.js";
import { streamToBuffer, safeJoinPosix, slugify, randomSuffix } from "./lib/util.js";

const PORT = process.env.PORT || 3000;

// --- Required env ---
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

// Optional env
const R2_ENDPOINT = process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
const MAIN_HOSTS = (process.env.MAIN_HOSTS || "quick-stage.app,www.quick-stage.app,quickstage.app,www.quickstage.app").split(",").map(s => s.trim()).filter(Boolean);
const HOSTING_BASE_DOMAIN = process.env.HOSTING_BASE_DOMAIN || "quick-stage.app"; // used for instructions / redirects
const SPA_FALLBACK = (process.env.SPA_FALLBACK || "true").toLowerCase() === "true";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || "50"); // zip size limit

if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error("Missing required R2 env vars. Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.");
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || "missing",
    secretAccessKey: R2_SECRET_ACCESS_KEY || "missing"
  }
});

const app = express();
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));

// CORS for your frontend
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || `https://qsv8.pages.dev,https://${HOSTING_BASE_DOMAIN}`).split(",").map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Health + info
app.get("/health", (req, res) => res.json({ ok: true, service: "quickstage-dev-hosting-backend" }));
app.get("/", (req, res) => {
  res.type("text/plain").send(
`QuickStage.dev Hosting API
- /api/projects  (create)
- /api/projects/:slug/upload (zip upload)
- /api/domains/verify?domain=example.com (DNS check)

If you're trying to view a hosted site, visit:
https://<project>.${HOSTING_BASE_DOMAIN}/`
  );
});

// ------------------------------------------------------------
// API (requires OAuth)
// ------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: "/tmp",
    filename: (req, file, cb) => cb(null, `upload-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`)
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

// Meta keys
const META_PREFIX = "__meta/projects/";
const SITES_PREFIX = "sites/";

async function projectExists(slug) {
  const key = `${META_PREFIX}${slug}.json`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function putJson(key, obj) {
  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: JSON.stringify(obj, null, 2),
    ContentType: "application/json; charset=utf-8",
    CacheControl: "no-store"
  }));
}

// Create a project
app.post("/api/projects", requireAuth, async (req, res) => {
  try {
    const { name, desiredSlug } = req.body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ ok: false, error: "name is required" });

    let slug = slugify(desiredSlug || name);
    if (!slug) return res.status(400).json({ ok: false, error: "Invalid name/slug" });

    // Ensure uniqueness: res -> res-123 if taken
    if (await projectExists(slug)) {
      let tries = 0;
      while (tries < 20) {
        const candidate = `${slug}-${randomSuffix(3)}`;
        if (!(await projectExists(candidate))) { slug = candidate; break; }
        tries++;
      }
      if (tries >= 20) return res.status(409).json({ ok: false, error: "Could not find an available slug. Try another name." });
    }

    const meta = {
      slug,
      name,
      createdAt: new Date().toISOString(),
      owner: req.user?.id || req.user?.email || "unknown",
      hostingUrl: `https://${slug}.${HOSTING_BASE_DOMAIN}`
    };

    await putJson(`${META_PREFIX}${slug}.json`, meta);
    res.json({ ok: true, project: meta });
  } catch (e) {
    console.error("Create project failed:", e);
    res.status(500).json({ ok: false, error: "Server error creating project" });
  }
});

// Upload ZIP for a project
app.post("/api/projects/:slug/upload", requireAuth, upload.single("file"), async (req, res) => {
  const slug = slugify(req.params.slug);
  if (!slug) return res.status(400).json({ ok: false, error: "Invalid project slug" });

  try {
    if (!(await projectExists(slug))) return res.status(404).json({ ok: false, error: "Project not found. Create it first." });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file (multipart field name must be 'file')" });

    const zipPath = req.file.path;

    let uploaded = 0;
    let skipped = 0;

    const directory = await unzipper.Open.file(zipPath);

    if (directory.files.length > 2000) {
      return res.status(400).json({ ok: false, error: "Zip has too many files (max 2000)." });
    }

    for (const entry of directory.files) {
      if (entry.type !== "File") { skipped++; continue; }

      const relPath = entry.path.replace(/^\/+/, "");
      if (relPath.includes("..")) { skipped++; continue; }

      const keyPath = safeJoinPosix(`${SITES_PREFIX}${slug}`, relPath);
      const contentType = lookupContentType(relPath) || "application/octet-stream";

      const bodyStream = entry.stream();
      await s3.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: keyPath,
        Body: bodyStream,
        ContentType: contentType,
        CacheControl: relPath.toLowerCase().endsWith(".html") ? "no-cache" : "public, max-age=86400"
      }));

      uploaded++;
    }

    res.json({
      ok: true,
      message: "Uploaded to R2",
      uploaded,
      skipped,
      url: `https://${slug}.${HOSTING_BASE_DOMAIN}/`
    });
  } catch (e) {
    console.error("Upload failed:", e);
    res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

// DNS verify ("interrogation")
app.get("/api/domains/verify", requireAuth, async (req, res) => {
  const domain = (req.query.domain || "").toString().trim().toLowerCase();
  if (!domain || domain.length < 3) return res.status(400).json({ ok: false, error: "domain is required" });

  try {
    const cname = await dohLookup(domain, "CNAME");
    const a = await dohLookup(domain, "A");
    const aaaa = await dohLookup(domain, "AAAA");

    res.json({
      ok: true,
      domain,
      records: { CNAME: cname, A: a, AAAA: aaaa },
      hint: `For a custom domain, set CNAME ${domain} -> <project>.${HOSTING_BASE_DOMAIN}`
    });
  } catch (e) {
    console.error("DNS verify failed:", e);
    res.status(500).json({ ok: false, error: "DNS lookup failed" });
  }
});

// ------------------------------------------------------------
// STATIC HOSTING (wildcard subdomains -> R2)
// ------------------------------------------------------------
function getProjectFromHost(host) {
  if (!host) return null;
  host = host.split(":")[0].toLowerCase();

  if (MAIN_HOSTS.includes(host)) return null;

  const base = HOSTING_BASE_DOMAIN.toLowerCase();
  if (host === base) return null;

  if (host.endsWith("." + base)) {
    const sub = host.slice(0, -(base.length + 1));
    const project = sub.split(".")[0];
    return slugify(project);
  }
  return null;
}

async function fetchObject(key) {
  return await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

app.get("*", async (req, res) => {
  try {
    const host = req.headers.host || "";
    const project = getProjectFromHost(host);
    if (!project) return res.status(404).type("text/plain").send("Not Found");

    let path = req.path || "/";
    if (path === "/") path = "/index.html";
    const rel = path.replace(/^\/+/, "");

    const baseKey = safeJoinPosix(`${SITES_PREFIX}${project}`, rel);
    try {
      const obj = await fetchObject(baseKey);
      const contentType = obj.ContentType || lookupContentType(rel) || "application/octet-stream";
      res.status(200);
      res.setHeader("Content-Type", contentType);
      if (obj.CacheControl) res.setHeader("Cache-Control", obj.CacheControl);

      const buf = await streamToBuffer(obj.Body);
      return res.send(buf);
    } catch {}

    if (!rel.includes(".") && !rel.endsWith("/")) {
      const htmlKey = safeJoinPosix(`${SITES_PREFIX}${project}`, `${rel}.html`);
      try {
        const obj = await fetchObject(htmlKey);
        res.setHeader("Content-Type", obj.ContentType || "text/html; charset=utf-8");
        const buf = await streamToBuffer(obj.Body);
        return res.send(buf);
      } catch {}
    }

    if (SPA_FALLBACK) {
      try {
        const obj = await fetchObject(`${SITES_PREFIX}${project}/index.html`);
        res.setHeader("Content-Type", obj.ContentType || "text/html; charset=utf-8");
        const buf = await streamToBuffer(obj.Body);
        return res.status(200).send(buf);
      } catch {}
    }

    res.status(404).type("text/plain").send("Not Found");
  } catch (e) {
    console.error("Serve error:", e);
    res.status(500).type("text/plain").send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`QuickStage.dev Hosting API listening on port ${PORT}`);
  console.log(`R2 endpoint: ${R2_ENDPOINT}`);
});
