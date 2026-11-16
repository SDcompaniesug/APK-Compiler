import { neon } from "@neondatabase/serverless";
import { requireAuth } from "./_auth.js";
import { json } from "./_shared.js";
import { Sandbox } from "@vercel/sandbox";

const db=()=>{if(!process.env.DATABASE_URL)throw new Error("Database unavailable.");return neon(process.env.DATABASE_URL);};
async function adminUser(req){
 const user=await requireAuth(req);
 const rows=await db().query("SELECT role FROM public.app_users WHERE id=$1 LIMIT 1",[user.id]);
 const role=rows[0]?.role||"user";
 if(!["super_admin","user_manager","build_manager","support_admin"].includes(role))throw Object.assign(new Error("Administrator access required."),{statusCode:403});
 return {...user,role};
}
async function audit(actor,action,type,id,details={}){
 await db().query("INSERT INTO public.compiler_admin_audit_logs(actor_id,actor_email,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[actor.id,actor.email,action,type||null,id==null?null:String(id),JSON.stringify(details)]);
}
export default async function handler(req,res){
 let actor;try{actor=await adminUser(req);}catch(e){return json(res,e.statusCode||401,{error:e.message||"Authentication required."});}
 const action=String(req.query?.action||"");
 const body=req.body||{};
 const sql=db();
 const superOnly=["settings","user-update","user-sessions-revoke","versions","announcement-delete","build-delete"];
 if(superOnly.includes(action)&&actor.role!=="super_admin")return json(res,403,{error:"Super Admin permission required."});
 try{
  if(req.method==="GET"&&action==="overview"){
   const r=await sql.query("SELECT (SELECT count(*)::int FROM public.app_users) users,(SELECT count(*)::int FROM public.build_jobs) builds,(SELECT count(*)::int FROM public.build_jobs WHERE state IN ('queued','building')) running,(SELECT maintenance_mode FROM public.compiler_admin_settings WHERE id=1) maintenance");
   return json(res,200,{...r[0],api:"Connected",database:"Connected"});
  }
  if(req.method==="GET"&&action==="users"){
   const q=String(req.query?.q||"").slice(0,100);
   const rows=await sql.query("SELECT u.id,u.name,u.email,u.role,u.status,u.created_at,(SELECT count(*)::int FROM public.build_jobs b WHERE b.user_id=u.id) build_count FROM public.app_users u WHERE ($1='' OR u.email ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%') ORDER BY u.created_at DESC LIMIT 200",[q]);
   return json(res,200,{users:rows});
  }
  if(req.method==="POST"&&action==="user-update"){
   const id=String(body.id||"");const role=String(body.role||"user");const status=String(body.status||"active");
   if(!id||!["user","super_admin","user_manager","build_manager","support_admin"].includes(role)||!["active","suspended","banned"].includes(status))return json(res,400,{error:"Invalid user update."});
   if(id===actor.id&&role!=="super_admin")return json(res,400,{error:"You cannot remove your own Super Admin role."});
   if(role!=="super_admin"){const n=await sql.query("SELECT count(*)::int n FROM public.app_users WHERE role='super_admin' AND status='active'");const target=await sql.query("SELECT role FROM public.app_users WHERE id=$1",[id]);if(target[0]?.role==="super_admin"&&Number(n[0]?.n||0)<=1)return json(res,409,{error:"Cannot demote the last active Super Admin."});}
   await sql.query("UPDATE public.app_users SET role=$1,status=$2 WHERE id=$3",[role,status,id]);
   await audit(actor,"user.update","user",id,{role,status});
   return json(res,200,{success:true,message:"User updated."});
  }
  if(req.method==="GET"&&action==="builds"){
   const rows=await sql.query("SELECT b.id,b.state,b.output_kind,b.error,b.created_at,b.updated_at,b.sandbox_name,u.email,u.name FROM public.build_jobs b LEFT JOIN public.app_users u ON u.id=b.user_id ORDER BY b.created_at DESC LIMIT 200");
   return json(res,200,{builds:rows});
  }
  if(req.method==="POST"&&action==="build-cancel"){
   const id=String(body.id||"");const rows=await sql.query("UPDATE public.build_jobs SET state='cancelled',error='Cancelled by administrator',updated_at=now() WHERE id=$1 AND state IN ('queued','building') RETURNING sandbox_name,user_id",[id]);
   if(!rows.length)return json(res,404,{error:"Active build not found."});
   if(rows[0].sandbox_name){try{const s=await Sandbox.get({name:rows[0].sandbox_name,resume:true});await s.stop();}catch{}}
   await audit(actor,"build.cancel","build",id,{});
   return json(res,200,{success:true,message:"Build cancellation requested."});
  }
  if(req.method==="POST"&&action==="build-delete"){
   const id=String(body.id||"");const row=await sql.query("SELECT user_id FROM public.build_jobs WHERE id=$1",[id]);if(!row.length)return json(res,404,{error:"Build not found."});
   const {deleteBuild}=await import("./_shared.js");await deleteBuild(id,row[0].user_id);await audit(actor,"build.delete","build",id,{});
   return json(res,200,{success:true,message:"Build record and artifacts deleted."});
  }
  if(req.method==="GET"&&action==="settings"){
   const r=await sql.query("SELECT * FROM public.compiler_admin_settings WHERE id=1");return json(res,200,{settings:r[0]||{}});
  }
  if(req.method==="POST"&&action==="settings"){
   const allowed=["registration_enabled","builds_enabled","maintenance_mode","max_upload_mb","max_concurrent_builds","build_timeout_minutes"];
   const sets=[],vals=[];for(const k of allowed)if(body[k]!==undefined){vals.push(body[k]);sets.push(k+"=$"+vals.length);}
   if(!sets.length)return json(res,400,{error:"No settings supplied."});
   vals.push(actor.id);await sql.query("UPDATE public.compiler_admin_settings SET "+sets.join(",")+",updated_by=$"+vals.length+",updated_at=now() WHERE id=1",vals);
   await audit(actor,"settings.update","platform","1",body);return json(res,200,{success:true,message:"Platform settings saved."});
  }
  if(req.method==="GET"&&action==="announcements"){
   const rows=await sql.query("SELECT * FROM public.compiler_announcements ORDER BY created_at DESC LIMIT 100");return json(res,200,{announcements:rows});
  }
  if(req.method==="POST"&&action==="announcements"){
   const title=String(body.title||"").trim().slice(0,140),message=String(body.body||"").trim().slice(0,5000),audience=body.audience==="selected"?"selected":"all";
   if(!title||!message)return json(res,400,{error:"Title and message are required."});
   const rows=await sql.query("INSERT INTO public.compiler_announcements(title,body,audience,created_by) VALUES($1,$2,$3,$4) RETURNING id",[title,message,audience,actor.id]);
   await audit(actor,"announcement.publish","announcement",rows[0].id,{audience});return json(res,201,{success:true,message:"Announcement published to the in-app announcement feed.",id:rows[0].id});
  }
  if(req.method==="GET"&&action==="versions"){
   const r=await sql.query("SELECT * FROM public.compiler_app_versions WHERE id=1");return json(res,200,{version:r[0]||{}});
  }
  if(req.method==="POST"&&action==="versions"){
   const latest=String(body.latest_version||"").trim(),minimum=String(body.minimum_version||"").trim(),force=!!body.force_update;
   if(!/^\d+\.\d+\.\d+$/.test(latest)||!/^\d+\.\d+\.\d+$/.test(minimum))return json(res,400,{error:"Use semantic versions such as 1.2.0."});
   await sql.query("UPDATE public.compiler_app_versions SET latest_version=$1,minimum_version=$2,force_update=$3,updated_by=$4,updated_at=now() WHERE id=1",[latest,minimum,force,actor.id]);
   await audit(actor,"versions.update","app","1",{latest,minimum,force});return json(res,200,{success:true,message:"Version policy saved."});
  }
  if(req.method==="GET"&&action==="sessions"){
   const rows=await sql.query("SELECT s.id,s.user_id,u.email,s.created_at,s.last_used_at,s.expires_at,s.revoked_at FROM public.auth_sessions s JOIN public.app_users u ON u.id=s.user_id WHERE s.revoked_at IS NULL AND s.expires_at>now() ORDER BY s.last_used_at DESC NULLS LAST LIMIT 200");return json(res,200,{sessions:rows});
  }
  if(req.method==="POST"&&action==="user-sessions-revoke"){
   const id=String(body.user_id||"");await sql.query("UPDATE public.auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",[id]);await audit(actor,"sessions.revoke","user",id,{});return json(res,200,{success:true,message:"User sessions revoked."});
  }
  if(req.method==="GET"&&action==="audit"){
   const rows=await sql.query("SELECT id,actor_email,action,target_type,target_id,details,created_at FROM public.compiler_admin_audit_logs ORDER BY created_at DESC LIMIT 200");return json(res,200,{events:rows});
  }
  if(req.method==="GET"&&action==="monitoring"){
   const r=await sql.query("SELECT (SELECT count(*)::int FROM public.app_users) users,(SELECT count(*)::int FROM public.build_jobs WHERE state IN ('queued','building')) running,(SELECT count(*)::int FROM public.build_jobs WHERE state='failed' AND updated_at>now()-interval '24 hours') failed_24h,(SELECT count(*)::int FROM public.build_jobs) builds");
   return json(res,200,{api:"healthy",database:"connected",storageConfigured:!!(process.env.AWS_BUCKET&&process.env.AWS_ENDPOINT_URL_S3),...r[0]});
  }
  if(req.method==="GET"&&action==="backups")return json(res,200,{provider:"Neon",status:"provider-managed",message:"Use Neon Console for verified restore points. Backup inventory API is not configured for this deployment."});
  if(req.method==="GET"&&action==="support"){
   const rows=await sql.query("SELECT * FROM public.compiler_support_tickets ORDER BY created_at DESC LIMIT 100");return json(res,200,{tickets:rows});
  }
  return json(res,405,{error:"Unsupported admin action or method."});
 }catch(e){return json(res,e.statusCode||500,{error:e.message||"Admin request failed."});}
}