import { downloadArtifact, json } from "./_shared.js";

export default async function handler(req,res) {
  if (req.method !== "GET") return json(res,405,{error:"Use GET."});
  try {
    await downloadArtifact(req.query?.id,req.query?.file,res,req.headers?.range || null);
  } catch (error) {
    if (!res.headersSent) return json(res,error.statusCode || 500,{error:error?.message || "Download failed."});
    res.destroy(error);
  }
}
