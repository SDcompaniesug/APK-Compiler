import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile, chown, chmod } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const required=["DATABASE_URL","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_ENDPOINT_URL_S3","AWS_REGION","AWS_BUCKET"];
for(const key of required)if(!process.env[key])throw new Error("Missing required worker variable "+key);
const sql=neon(process.env.DATABASE_URL);
const s3=new S3Client({region:process.env.AWS_REGION,endpoint:process.env.AWS_ENDPOINT_URL_S3,forcePathStyle:true,credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}});
const bucket=process.env.AWS_BUCKET;
const workerId=process.env.WORKER_ID||os.hostname();
const base="/tmp/apk-compiler-job";
const runner=path.join(base,"run-build.sh");
const builderUid=Number(process.env.BUILDER_UID||10001);
const builderGid=Number(process.env.BUILDER_GID||10001);
const maxMs=Math.min(60,Math.max(5,Number(process.env.MAX_BUILD_MINUTES||45)))*60*1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function bufferBody(body,max=50*1024*1024){
  const parts=[];let size=0;
  for await(const chunk of body){const b=Buffer.from(chunk);size+=b.length;if(size>max)throw new Error("Uploaded project ZIP exceeds 50 MB.");parts.push(b);}
  return Buffer.concat(parts,size);
}
async function deleteObject(key){try{await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));}catch{}}
async function runCommand(outputKind){
  const env={
    PATH:"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/cmdline-tools/latest/bin:/opt/flutter/bin",
    HOME:"/home/builder",
    JAVA_HOME:process.env.JAVA_HOME||"/opt/java/openjdk",
    ANDROID_HOME:"/opt/android-sdk",
    ANDROID_SDK_ROOT:"/opt/android-sdk",
    OUTPUT_KIND:outputKind,
    LANG:"C.UTF-8",
    CI:"true"
  };
  return await new Promise((resolve,reject)=>{
    const child=spawn("bash",[runner],{cwd:base,env,uid:builderUid,gid:builderGid,stdio:["ignore","inherit","inherit"]});
    const timer=setTimeout(()=>child.kill("SIGKILL"),maxMs);
    child.once("error",e=>{clearTimeout(timer);reject(e);});
    child.once("close",(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
  });
}
async function processJob(job){
  const id=job.id;
  const uploadKey=job.upload_key;
  console.log("Claimed build",id,"output",job.output_kind);
  try{
    const obj=await s3.send(new GetObjectCommand({Bucket:bucket,Key:uploadKey}));
    const zip=await bufferBody(obj.Body);
    await rm(base,{recursive:true,force:true});
    await mkdir(path.join(base,"input"),{recursive:true});
    await mkdir(path.join(base,"output"),{recursive:true});
    await writeFile(path.join(base,"input","project.zip"),zip,{mode:0o600});
    const source=await readFile("/app/worker/run-build.sh");
    await writeFile(runner,source,{mode:0o755});
    await chown(base,builderUid,builderGid);
    await chown(path.join(base,"input"),builderUid,builderGid);
    await chown(path.join(base,"output"),builderUid,builderGid);
    await chown(path.join(base,"input","project.zip"),builderUid,builderGid);
    await chown(runner,builderUid,builderGid);
    await chmod(runner,0o755);
    const result=await runCommand(job.output_kind||"apk");
    let state={};
    try{state=JSON.parse(await readFile(path.join(base,"status.json"),"utf8"));}catch{}
    if(result.code!==0||state.state!=="complete"){
      let detail=String(state.error||"Build process failed (exit "+result.code+").");
      try{const log=await readFile(path.join(base,"build.log"),"utf8");if(log)detail=log.slice(-12000);}catch{}
      throw new Error(detail.slice(-12000));
    }
    const artifacts={};
    for(const key of ["apk","aab"]){
      if(!state[key])continue;
      const bytes=await readFile(state[key]).catch(()=>null);
      if(!bytes?.length)continue;
      const objectKey="builds/"+id+"/"+key+(key==="apk"?".apk":".aab");
      await s3.send(new PutObjectCommand({Bucket:bucket,Key:objectKey,Body:bytes,ContentType:key==="apk"?"application/vnd.android.package-archive":"application/octet-stream"}));
      artifacts[key]={size:bytes.length,url:"/api/download?id="+id+"&file="+key};
    }
    if(state.appName)artifacts.appName=String(state.appName).slice(0,120);
    if(state.appIconBase64){
      const icon=Buffer.from(String(state.appIconBase64),"base64");
      if(icon.length>0&&icon.length<=60000){
        const type=icon.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?"image/png":icon.subarray(0,4).toString("ascii")==="RIFF"?"image/webp":"image/jpeg";
        await s3.send(new PutObjectCommand({Bucket:bucket,Key:"builds/"+id+"/icon.img",Body:icon,ContentType:type,CacheControl:"private, max-age=86400"}));
        artifacts.appIcon={url:"/api/icon?id="+id,contentType:type};
      }
    }
    if(!artifacts.apk&&!artifacts.aab)throw new Error("Build completed but no APK or AAB artifact could be read.");
    const updated=await sql.query("UPDATE build_jobs SET state='complete',artifacts=$1::jsonb,error=NULL,sandbox_name=NULL,updated_at=now() WHERE id=$2 AND state='building' RETURNING id",[JSON.stringify(artifacts),id]);
    if(!updated.length){
      await Promise.all(["apk","aab","icon.img"].map(k=>deleteObject("builds/"+id+"/"+(k==="icon.img"?k:k+(k==="apk"?".apk":".aab")))));
    }else console.log("Build completed",id);
    await deleteObject(uploadKey);
  }catch(error){
    const message=String(error?.message||error).slice(-12000);
    console.error("Build failed",id,message);
    await sql.query("UPDATE build_jobs SET state='failed',error=$1,sandbox_name=NULL,updated_at=now() WHERE id=$2 AND state='building'",[message,id]).catch(()=>{});
    await deleteObject(uploadKey);
  }finally{
    await rm(base,{recursive:true,force:true}).catch(()=>{});
  }
}
async function claimJob(){
  const rows=await sql.query(
    "UPDATE build_jobs SET state='building',sandbox_name=$1,updated_at=now(),error=NULL WHERE id=(SELECT id FROM build_jobs WHERE state='queued' AND sandbox_name='railway-pending' AND upload_key IS NOT NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,user_id,output_kind,upload_key",
    [workerId]
  );
  return rows[0]||null;
}
async function main(){
  console.log("APK Compiler worker online",workerId);
  await sql.query("UPDATE build_jobs SET state='queued',sandbox_name='railway-pending',updated_at=now() WHERE state='building' AND updated_at<now()-interval '70 minutes'").catch(()=>{});
  for(;;){
    try{
      const job=await claimJob();
      if(job)await processJob(job);
      else await sleep(3500);
    }catch(error){console.error("Worker loop error",error);await sleep(5000);}
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
