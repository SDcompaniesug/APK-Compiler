import { json } from "../_shared.js";
import { requireAuth } from "../_auth.js";
export default async function handler(req,res) {
  if (req.method !== "GET") return json(res,405,{error:"Use GET."});
  try {
    const user = await requireAuth(req);
    return json(res,200,{user:{id:user.id,name:user.name,email:user.email}});
  } catch (error) {
    return json(res,error.statusCode || 500,{error:error.message || "Could not verify session."});
  }
}