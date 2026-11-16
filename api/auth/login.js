import { json } from "../_shared.js";
import { loginAccount } from "../_auth.js";
export default async function handler(req,res) {
  if (req.method !== "POST") return json(res,405,{error:"Use POST."});
  try {
    const body = req.body || {};
    return json(res,200,await loginAccount(body.email,body.password));
  } catch (error) {
    return json(res,error.statusCode || 500,{error:error.message || "Could not sign in."});
  }
}