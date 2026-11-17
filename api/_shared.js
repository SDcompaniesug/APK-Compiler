import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

export function json(res,status,data){res.statusCode=status;res.setHeader("content-type","application/json; charset=utf-8");res.setHeader("cache-control","no-store");res.end(JSON.stringify(data));}
export const newId=()=>randomUUID().replaceAll("-","");
function database(){if(!process.env.DATABASE_URL)throw Object.assign(new Error("Neon database is not configured."),{statusCode:503});return neon(process.env.DATABASE_URL);}
function storage(){
  const required=["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_ENDPOINT_URL_S3","AWS_REGION","AWS_BUCKET"];
  for(const key of required)if(!process.env[key])throw Object.assign(new Error("Neon Object Storage is missing "+key+"."),{statusCode:503});
  return new S3Client({region:process.env.AWS_REGION,endpoint:process.env.AWS_ENDPOINT_URL_S3,forcePathStyle:true,credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}});
}
function validateOutput(output){if(!["apk","aab","both","release-apk","release-aab","release-both"].includes(output))throw Object.assign(new Error("Choose a supported debug or release output."),{statusCode:400});return output;}
export async function createUpload(id,filename,userId){
  if(!/\.zip$/i.test(String(filename||"")))throw Object.assign(new Error("Choose a .zip project file."),{statusCode:400});
  const key="uploads/"+id+".zip";
  const uploadUrl="/api/upload?pathname="+encodeURIComponent(key);
  const rows=await database().query("INSERT INTO build_jobs (id,user_id,state,output_kind,upload_key,sandbox_name,created_at,updated_at,expires_at) VALUES ($1,$2,'uploading','apk',$3,'railway-pending',now(),now(),now()+interval '24 hours') ON CONFLICT (id) DO UPDATE SET state='uploading',upload_key=EXCLUDED.upload_key,sandbox_name='railway-pending',updated_at=now() WHERE build_jobs.user_id=EXCLUDED.user_id RETURNING id",[id,userId,key]);
  if(!rows.length)throw Object.assign(new Error("Could not reserve this upload for your account."),{statusCode:409});
  return {pathname:key,uploadUrl,validUntil:Date.now()+900000,maxBytes:50*1024*1024};
}
export async function receiveUpload(pathname,req,res,userId){
  if(typeof pathname!=="string"||!/^uploads\/[a-f0-9]{32}\.zip$/.test(pathname))throw Object.assign(new Error("Invalid upload reference."),{statusCode:400});
  const length=Number(req.headers["content-length"]||0);
  if(!Number.isSafeInteger(length)||length<22||length>50*1024*1024)throw Object.assign(new Error("Project ZIP must be between 22 bytes and 50 MB."),{statusCode:413});
  const rows=await database().query("SELECT id FROM build_jobs WHERE id=$1 AND user_id=$2 AND upload_key=$3 AND state='uploading' LIMIT 1",[pathname.split("/")[1].replace(/\.zip$/,""),userId,pathname]);
  if(!rows.length)throw Object.assign(new Error("Upload was not found, expired, or already received."),{statusCode:404});
  let total=0;
  const {Transform}=await import("node:stream");
  const limiter=new Transform({transform(chunk,encoding,callback){total+=chunk.length;if(total>50*1024*1024){callback(new Error("Upload exceeds 50 MB."));return;}callback(null,chunk);},flush(callback){if(total!==length)callback(new Error("Upload size did not match Content-Length."));else callback();}});
  try{
    await storage().send(new PutObjectCommand({Bucket:process.env.AWS_BUCKET,Key:pathname,Body:req.pipe(limiter),ContentLength:length,ContentType:"application/zip"}));
    json(res,200,{success:true,pathname});
  }catch(error){throw Object.assign(new Error(error.message||"Could not store uploaded project."),{statusCode:400});}
}
export async function startBuild(zip,output="apk",existingId=null,userId){
  validateOutput(output);
  if(!Buffer.isBuffer(zip)||zip.length<22||zip.length>50*1024*1024)throw Object.assign(new Error("Project ZIP must be between 22 bytes and 50 MB."),{statusCode:400});
  const id=existingId||newId(),key="uploads/"+id+".zip",client=storage();
  await client.send(new PutObjectCommand({Bucket:process.env.AWS_BUCKET,Key:key,Body:zip,ContentType:"application/zip"}));
  try{const rows=await database().query("INSERT INTO build_jobs (id,user_id,state,output_kind,upload_key,sandbox_name,created_at,updated_at,expires_at) VALUES ($1,$2,'queued',$3,$4,'railway-pending',now(),now(),now()+interval '7 days') ON CONFLICT (id) DO UPDATE SET state='queued',output_kind=EXCLUDED.output_kind,upload_key=EXCLUDED.upload_key,sandbox_name='railway-pending',error=NULL,updated_at=now(),expires_at=now()+interval '7 days' WHERE build_jobs.user_id=EXCLUDED.user_id RETURNING id",[id,userId,output,key]);
    if(!rows.length)throw Object.assign(new Error("Build job could not be saved for this account."),{statusCode:409});}
  catch(error){try{await client.send(new DeleteObjectCommand({Bucket:process.env.AWS_BUCKET,Key:key}));}catch{}throw error;}
  return {jobId:id,state:"queued",statusUrl:"/api/status?id="+id};
}
export async function startBuildFromBlob(pathname,output="apk",userId){
  validateOutput(output);
  if(typeof pathname!=="string"||!/^uploads\/[a-f0-9]{32}\.zip$/.test(pathname))throw Object.assign(new Error("Invalid uploaded project reference."),{statusCode:400});
  const id=pathname.split("/")[1].replace(/\.zip$/,""),sql=database();
  const rows=await sql.query("SELECT id,state,upload_key FROM build_jobs WHERE id=$1 AND user_id=$2 LIMIT 1",[id,userId]);
  if(!rows.length||rows[0].upload_key!==pathname)throw Object.assign(new Error("Uploaded project was not found or has expired."),{statusCode:404});
  if(rows[0].state!=="uploading")throw Object.assign(new Error("This upload has already been started or is no longer available."),{statusCode:409});
  const head=await storage().send(new HeadObjectCommand({Bucket:process.env.AWS_BUCKET,Key:pathname}));
  if(!Number.isFinite(head.ContentLength)||head.ContentLength<22||head.ContentLength>50*1024*1024)throw Object.assign(new Error("Uploaded project ZIP must be between 22 bytes and 50 MB."),{statusCode:400});
  const queued=await sql.query("UPDATE build_jobs SET state='queued',output_kind=$1,updated_at=now(),expires_at=now()+interval '7 days' WHERE id=$2 AND user_id=$3 AND state='uploading' RETURNING id",[output,id,userId]);
  if(!queued.length)throw Object.assign(new Error("This upload has already been claimed or is no longer available."),{statusCode:409});
  return {jobId:id,state:"queued",statusUrl:"/api/status?id="+id};
}
export async function getBuild(id,userId){
  if(!/^[a-f0-9]{32}$/.test(id||""))throw Object.assign(new Error("Invalid job ID."),{statusCode:400});
  const rows=await database().query("SELECT id,state,error,artifacts FROM build_jobs WHERE id=$1 AND user_id=$2 LIMIT 1",[id,userId]);
  if(!rows.length)throw Object.assign(new Error("Build not found."),{statusCode:404});
  const job=rows[0],result={jobId:id,state:job.state||"queued"};
  if(job.state==="complete")result.artifacts=job.artifacts||{};
  if(job.state==="failed")result.error=job.error||"Build failed.";
  if(job.state==="cancelled")result.error="Build was cancelled.";
  return result;
}
export async function downloadArtifact(id,file,res,rangeHeader=null,userId){
  if(!/^[a-f0-9]{32}$/.test(id||"")||!["apk","aab"].includes(file))throw Object.assign(new Error("Invalid artifact request."),{statusCode:400});
  const rows=await database().query("SELECT state,artifacts FROM build_jobs WHERE id=$1 AND user_id=$2 LIMIT 1",[id,userId]);
  if(!rows.length||rows[0].state!=="complete"||!rows[0].artifacts?.[file])throw Object.assign(new Error("Artifact not found."),{statusCode:404});
  const key="builds/"+id+"/"+file+(file==="apk"?".apk":".aab"),range=typeof rangeHeader==="string"&&/^bytes=\d+-\d*$/.test(rangeHeader)?rangeHeader:undefined;
  const result=await storage().send(new GetObjectCommand({Bucket:process.env.AWS_BUCKET,Key:key,...(range?{Range:range}:{})}));
  res.statusCode=range?206:200;res.setHeader("content-type",file==="apk"?"application/vnd.android.package-archive":"application/octet-stream");
  res.setHeader("content-disposition",'attachment; filename="android-'+file+(file==="apk"?".apk":".aab")+'"');res.setHeader("cache-control","private, no-store");
  res.setHeader("x-content-type-options","nosniff");res.setHeader("accept-ranges","bytes");
  if(result.ContentLength!=null)res.setHeader("content-length",String(result.ContentLength));if(result.ContentRange)res.setHeader("content-range",result.ContentRange);
  for await(const chunk of result.Body)if(!res.write(Buffer.from(chunk)))await new Promise(resolve=>res.once("drain",resolve));res.end();
}
export async function deleteBuild(id,userId){
  if(!/^[a-f0-9]{32}$/.test(id||""))throw Object.assign(new Error("Invalid build ID."),{statusCode:400});
  const sql=database(),rows=await sql.query("SELECT id,upload_key FROM build_jobs WHERE id=$1 AND user_id=$2 LIMIT 1",[id,userId]);
  if(!rows.length)throw Object.assign(new Error("Build not found."),{statusCode:404});
  await sql.query("DELETE FROM build_jobs WHERE id=$1 AND user_id=$2",[id,userId]);
  const keys=[rows[0].upload_key,"builds/"+id+"/apk.apk","builds/"+id+"/aab.aab","builds/"+id+"/icon.img"].filter(Boolean);
  await Promise.all(keys.map(Key=>storage().send(new DeleteObjectCommand({Bucket:process.env.AWS_BUCKET,Key})).catch(()=>{})));
  return {success:true,deleted:id};
}
export async function getAppIcon(id,res,userId){
  if(!/^[a-f0-9]{32}$/.test(id||""))throw Object.assign(new Error("Invalid build ID."),{statusCode:400});
  const rows=await database().query("SELECT state,artifacts FROM build_jobs WHERE id=$1 AND user_id=$2 LIMIT 1",[id,userId]);
  if(!rows.length||rows[0].state!=="complete"||!rows[0].artifacts?.appIcon)throw Object.assign(new Error("App icon not found."),{statusCode:404});
  const result=await storage().send(new GetObjectCommand({Bucket:process.env.AWS_BUCKET,Key:"builds/"+id+"/icon.img"}));
  res.statusCode=200;res.setHeader("content-type",rows[0].artifacts.appIcon.contentType||"image/png");res.setHeader("cache-control","private, max-age=86400");res.setHeader("x-content-type-options","nosniff");
  for await(const chunk of result.Body)if(!res.write(Buffer.from(chunk)))await new Promise(resolve=>res.once("drain",resolve));res.end();
}
