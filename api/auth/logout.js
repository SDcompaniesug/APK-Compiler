import { json } from "../_shared.js";
import { revokeRefreshToken } from "../_auth.js";
export default async function handler(req,res) {
  if (req.method !== "POST") return json(res,405,{error:"Use POST."});
  try {
    await revokeRefreshToken(req.body?.refreshToken);
    return json(res,200,{success:true});
  } catch (error) {
    return json(res,error.statusCode || 500,{error:"Could not end session."});
  }
}