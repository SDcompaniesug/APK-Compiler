import { json } from "../_shared.js";
import { rotateRefreshToken } from "../_auth.js";
export default async function handler(req,res) {
  if (req.method !== "POST") return json(res,405,{error:"Use POST."});
  try {
    return json(res,200,await rotateRefreshToken(req.body?.refreshToken));
  } catch (error) {
    return json(res,error.statusCode || 500,{error:error.message || "Could not refresh session."});
  }
}