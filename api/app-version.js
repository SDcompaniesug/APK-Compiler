import { neon } from "@neondatabase/serverless";
import { json } from "./_shared.js";
export default async function handler(req,res){
 if(req.method!=="GET")return json(res,405,{error:"Use GET."});
 try{
  if(!process.env.DATABASE_URL)throw Object.assign(new Error("Database unavailable."),{statusCode:503});
  const sql=neon(process.env.DATABASE_URL);
  const rows=await sql.query("SELECT version_name,version_code,minimum_supported_code,download_url,release_notes,force_update FROM public.compiler_app_versions WHERE platform='android' AND active=true ORDER BY version_code DESC LIMIT 1");
  const latest=rows[0]||null;const current=Number.parseInt(String(req.query?.versionCode||"0"),10)||0;
  return json(res,200,{available:!!latest,latestVersion:latest?.version_name||null,latestVersionCode:latest?.version_code||0,minimumSupportedCode:latest?.minimum_supported_code||1,forceUpdate:!!latest&&(current<(latest.minimum_supported_code||1)||!!latest.force_update&&current<(latest.version_code||0)),downloadUrl:latest?.download_url||null,releaseNotes:latest?.release_notes||""});
 }catch(e){return json(res,e.statusCode||500,{error:e.message||"Could not check app version."});}
}
