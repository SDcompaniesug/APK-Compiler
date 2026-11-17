import { getBuild, json } from "../lib/_shared.js";
import { requireAuth } from "../lib/_auth.js";
export default async function handler(req,res) {
  if (req.method !== "GET") return json(res,405,{error:"Use GET."});
  try {
    const user = await requireAuth(req);
    const result = await getBuild(req.query?.id,user.id);
    return json(res,200,result);
  } catch (error) {
    return json(res,error.statusCode || 404,{error:error?.message || "Build not found."});
  }
}
