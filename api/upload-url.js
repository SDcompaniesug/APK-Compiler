import { createUpload, json, newId } from "./_shared.js";

export default async function handler(req,res) {
  if (req.method !== "POST") return json(res,405,{error:"Use POST."});
  try {
    const filename = String(req.body?.filename || "");
    if (!filename.toLowerCase().endsWith(".zip")) return json(res,400,{error:"Choose a .zip project file."});
    const result = await createUpload(newId(),filename);
    return json(res,200,result);
  } catch (error) {
    return json(res,500,{error:error?.message || "Could not prepare secure upload."});
  }
}
