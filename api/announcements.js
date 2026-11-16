import { neon } from "@neondatabase/serverless";
import { requireAuth } from "./_auth.js";
import { json } from "./_shared.js";
export default async function handler(req,res){
 if(req.method!=="GET")return json(res,405,{error:"Use GET."});
 try{
  const user=await requireAuth(req);
  if(!process.env.DATABASE_URL)throw Object.assign(new Error("Database unavailable."),{statusCode:503});
  const sql=neon(process.env.DATABASE_URL);
  const rows=await sql.query("SELECT id,title,body,kind,starts_at,ends_at,created_at FROM public.compiler_announcements WHERE active=true AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now()) AND (audience='all' OR $1=ANY(target_user_ids)) ORDER BY created_at DESC LIMIT 50",[user.id]);
  return json(res,200,{announcements:rows});
 }catch(e){return json(res,e.statusCode||500,{error:e.message||"Could not load announcements."});}
}
