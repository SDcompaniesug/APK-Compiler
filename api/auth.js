import { json } from "../lib/_shared.js";
import { loginAccount, revokeRefreshToken, requireAuth, rotateRefreshToken, registerAccount } from "../lib/_auth.js";

export default async function handler(req, res) {
  const route = Array.isArray(req.query?.route) ? req.query.route.join("/") : String(req.query?.route || "");
  if (route === "login") {
    if (req.method !== "POST") return json(res,405,{error:"Use POST."});
    try { const body=req.body||{}; return json(res,200,await loginAccount(body.email,body.password)); }
    catch(error) { return json(res,error.statusCode||500,{error:error.message||"Could not sign in."}); }
  }
  if (route === "logout") {
    if (req.method !== "POST") return json(res,405,{error:"Use POST."});
    try { await revokeRefreshToken(req.body?.refreshToken); return json(res,200,{success:true}); }
    catch(error) { return json(res,error.statusCode||500,{error:"Could not end session."}); }
  }
  if (route === "me") {
    if (req.method !== "GET") return json(res,405,{error:"Use GET."});
    try { const user=await requireAuth(req); return json(res,200,{user:{id:user.id,name:user.name,email:user.email}}); }
    catch(error) { return json(res,error.statusCode||500,{error:error.message||"Could not verify session."}); }
  }
  if (route === "refresh") {
    if (req.method !== "POST") return json(res,405,{error:"Use POST."});
    try { return json(res,200,await rotateRefreshToken(req.body?.refreshToken)); }
    catch(error) { return json(res,error.statusCode||500,{error:error.message||"Could not refresh session."}); }
  }
  if (route === "register") {
    if (req.method !== "POST") return json(res,405,{error:"Use POST."});
    try { const body=req.body||{}; return json(res,201,await registerAccount(body.name,body.email,body.password)); }
    catch(error) { return json(res,error.statusCode||500,{error:error.message||"Could not create account."}); }
  }
  return json(res,404,{error:"Authentication route not found."});
}