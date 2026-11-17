import { downloadArtifact, json } from "../lib/_shared.js";
import { requireAuth } from "../lib/_auth.js";

export default async function handler(req,res) {
  if (req.method !== "GET") return json(res,405,{error:"Use GET."});
  try {
    const user = await requireAuth(req);
    await downloadArtifact(req.query?.id,req.query?.file,res,req.headers?.range || null,user.id);
  } catch (error) {
    if (!res.headersSent) return json(res,error.statusCode || 500,{error:error?.message || "Download failed."});
    res.destroy(error);
  }
}
