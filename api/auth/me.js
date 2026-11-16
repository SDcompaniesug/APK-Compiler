import { neon } from "@neondatabase/serverless";
import { json } from "../_shared.js";
import { requireAuth } from "../_auth.js";
export default async function handler(req,res) {
  if (req.method !== "GET") return json(res,405,{error:"Use GET."});
  try {
    const user = await requireAuth(req);
    const sql=neon(process.env.DATABASE_URL);
    const rows=await sql.query("SELECT role,status FROM public.app_users WHERE id=$1 LIMIT 1",[user.id]);
    const role=rows[0]?.role||"user";
    const isAdmin=["super_admin","user_manager","build_manager","support_admin"].includes(role);
    return json(res,200,{user:{id:user.id,name:user.name,email:user.email},role,isAdmin,permissions:{full:role==="super_admin",users:["super_admin","user_manager"].includes(role),builds:["super_admin","build_manager"].includes(role),support:["super_admin","support_admin"].includes(role)}});
  } catch (error) {
    return json(res,error.statusCode || 500,{error:error.message || "Could not verify session."});
  }
}