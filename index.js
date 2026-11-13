import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import build from "./api/build.js";
import status from "./api/status.js";
import download from "./api/download.js";
import uploadUrl from "./api/upload-url.js";
import mcp from "./api/mcp.js";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "public", "index.html"), "utf8");

async function parseJson(req) {
  if (req.body && typeof req.body === "object") return;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  req.body = raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  const url = new URL(req.url || "/", "https://apk-compiler.local");
  req.query = Object.fromEntries(url.searchParams.entries());
  try {
    if (url.pathname === "/api/build") { if ((req.headers["content-type"] || "").includes("application/json")) await parseJson(req); return await build(req, res); }
    if (url.pathname === "/api/upload-url") { await parseJson(req); return await uploadUrl(req, res); }
    if (url.pathname === "/api/status") return await status(req, res);
    if (url.pathname === "/api/download") return await download(req, res);
    if (url.pathname === "/api/mcp") {
      if (req.method === "POST") await parseJson(req);
      return await mcp(req, res);
    }
    if (url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ status: "ok", service: "apk-compiler" }));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(html);
    }
    res.statusCode = 404;
    res.end("Not found");
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: error?.message || "Internal server error" }));
  }
}
