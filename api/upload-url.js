import { issueSignedToken, presignUrl } from "@vercel/blob";
import { json, newId } from "./_shared.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Use POST." });
  try {
    const name = String(req.body?.filename || "");
    if (!name.toLowerCase().endsWith(".zip")) return json(res, 400, { error: "Choose a .zip project file." });
    const id = newId();
    const pathname = "uploads/" + id + ".zip";
    const validUntil = Date.now() + 15 * 60 * 1000;
    const constraints = {
      pathname,
      operations: ["put"],
      allowedContentTypes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
      maximumSizeInBytes: 50 * 1024 * 1024,
      validUntil
    };
    const token = await issueSignedToken(constraints);
    const signed = await presignUrl(token, {
      operation: "put",
      pathname,
      access: "private",
      allowedContentTypes: constraints.allowedContentTypes,
      maximumSizeInBytes: constraints.maximumSizeInBytes,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: false
    });
    return json(res, 200, { pathname, uploadUrl: signed.presignedUrl, validUntil, maxBytes: constraints.maximumSizeInBytes });
  } catch (error) {
    return json(res, 500, { error: error?.message || "Could not prepare upload." });
  }
}
