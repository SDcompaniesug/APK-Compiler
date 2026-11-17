import { getAppIcon } from "../lib/_shared.js";
import { requireAuth } from "../lib/_auth.js";

export default async function handler(req,res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type","application/json; charset=utf-8");
    return res.end(JSON.stringify({error:"Use GET."}));
  }
  try {
    const user = await requireAuth(req);
    await getAppIcon(req.query?.id,res,user.id);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = error.statusCode || 500;
      res.setHeader("content-type","application/json; charset=utf-8");
      res.end(JSON.stringify({error:error?.message || "Could not load app icon."}));
    } else res.destroy(error);
  }
}
