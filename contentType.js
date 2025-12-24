import mime from "mime-types";

export function lookupContentType(path) {
  const ct = mime.lookup(path);
  if (!ct) return null;

  if (ct === "text/html") return "text/html; charset=utf-8";
  if (ct === "text/css") return "text/css; charset=utf-8";
  if (ct === "application/javascript") return "application/javascript; charset=utf-8";
  if (ct === "text/plain") return "text/plain; charset=utf-8";
  if (ct === "application/json") return "application/json; charset=utf-8";
  return ct.toString();
}
