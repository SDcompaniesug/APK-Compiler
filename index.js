import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "public", "index.html"), "utf8");
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}
