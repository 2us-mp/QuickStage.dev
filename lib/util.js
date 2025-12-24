export function slugify(input) {
  if (!input) return "";
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

export function randomSuffix(len = 3) {
  const digits = "0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += digits[Math.floor(Math.random() * digits.length)];
  return out;
}

export function safeJoinPosix(prefix, rel) {
  const joined = `${prefix}/${rel}`.replace(/\/+/, "/").replace(/\/+/g, "/");
  const parts = joined.split("/").filter(Boolean);
  const safe = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") continue;
    safe.push(p);
  }
  return safe.join("/");
}

export async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
