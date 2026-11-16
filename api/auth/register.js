import { json } from "../_shared.js";
import { registerAccount } from "../_auth.js";
export default async function handler(req,res) {
  if (req.method !== "POST") return json(res,405,{error:"Use POST."});
  try {
    const body = req.body || {};
    return json(res,201,await registerAccount(body.name,body.email,body.password));
  } catch (error) {
    return json(res,error.statusCode || 500,{error:error.message || "Could not create account."});
  }
}