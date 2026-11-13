import { get } from "@vercel/blob";
import { json } from "./_shared.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "Use GET." });
  const id = req.query?.id;
  const file = req.query?.file;
  if (!/^[a-f0-9]{32}$/.test(id || "") || !["apk", "aab"].includes(file)) {
    return json(res, 400, { error: "Invalid artifact request." });
  }
  try {
    const pathname = "builds/" + id + "/" + file + (file === "apk" ? ".apk" : ".aab");
    const blob = await get(pathname, { access: "private" });
    if (!blob || blob.statusCode !== 200 || !blob.stream) return json(res, 404, { error: "Artifact not found." });
    res.statusCode = 200;
    res.setHeader("content-type", file === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream");
    res.setHeader("content-disposition", 'attachment; filename="android-debug.' + file + '"');
    res.setHeader("cache-control", "private, no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const reader = blob.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
    }
    res.end();
  } catch (error) {
    return json(res, 500, { error: error?.message || "Download failed." });
  }
}
