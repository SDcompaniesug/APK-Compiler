import Busboy from "busboy";
import { startBuild, json } from "./_shared.js";
export const config = { api:{bodyParser:false} };
export default async function handler(req,res) {
  if (req.method !== "POST") return json(res,405,{error:"Use POST with multipart/form-data."});
  try {
    const bb=Busboy({headers:req.headers,limits:{fileSize:50*1024*1024,files:1,fields:2}});
    let zip=null, output="apk", failed=null;
    const parsed=new Promise((resolve,reject)=>{
      bb.on("file",(name,file,info)=>{
        if(name!=="project" || !/\.zip$/i.test(info.filename)){failed="Upload a .zip file in the project field.";file.resume();return;}
        const chunks=[];file.on("data",d=>chunks.push(d));file.on("limit",()=>{failed="ZIP exceeds 50 MB.";});file.on("end",()=>{zip=Buffer.concat(chunks);});
      });
      bb.on("field",(name,value)=>{if(name==="output")output=value;});
      bb.on("error",reject);bb.on("finish",resolve);
    });
    req.pipe(bb); await parsed;
    if(failed) throw new Error(failed);
    if(!zip) throw new Error("Missing project ZIP.");
    const job=await startBuild(zip,output);
    return json(res,202,job);
  } catch(e) { return json(res,400,{error:e.message||"Build could not be started."}); }
}
