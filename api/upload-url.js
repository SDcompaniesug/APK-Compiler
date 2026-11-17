import { createUpload, json, newId } from "../lib/_shared.js";
import { requireAuth } from "../lib/_auth.js";

export default async function handler(req,res) {
  if (req.method !== "POST") return json(res,405,{error:"Use POST."});
  try {
    const user = await requireAuth(req);
    const filename = String(req.body?.filename || "");
    if (!filename.toLowerCase().endsWith(".zip")) return json(res,400,{error:"Choose a .zip project file."});
    const result = await createUpload(newId(),filename,user.id);
    return json(res,200,result);
  } catch (error) {
    return json(res,error.statusCode || 500,{error:error?.message || "Could not prepare secure upload."});
  }
}
