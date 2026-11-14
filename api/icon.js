import { getAppIcon } from "./_shared.js";

export default async function handler(req,res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type","application/json; charset=utf-8");
    return res.end(JSON.stringify({error:"Use GET."}));
  }
  try {
    await getAppIcon(req.query?.id,res);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = error.statusCode || 500;
      res.setHeader("content-type","application/json; charset=utf-8");
      res.end(JSON.stringify({error:error?.message || "Could not load app icon."}));
    } else res.destroy(error);
  }
}
