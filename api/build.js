import Busboy from "busboy";
import { startBuild, startBuildFromBlob, json } from "./_shared.js";
export const config = { api: { bodyParser: false } };

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req,res) {
  if (req.method !== "POST") return json(res,405,{error:"Use POST."});
  try {
    if ((req.headers["content-type"] || "").includes("application/json")) {
      const body = await readJson(req);
      const job = await startBuildFromBlob(body.pathname,body.output || "apk");
      return json(res,202,job);
    }
    const bb = Busboy({headers:req.headers,limits:{fileSize:4*1024*1024,files:1,fields:2}});
    let zip = null, output = "apk", failed = null;
    const parsed = new Promise((resolve,reject) => {
      bb.on("file",(name,file,info) => {
        if (name !== "project" || !/\.zip$/i.test(info.filename)) {
          failed = "Upload a .zip file in the project field."; file.resume(); return;
        }
        const chunks = [];
        file.on("data",d=>chunks.push(d));
        file.on("limit",()=>{failed="Direct multipart uploads are limited to 4 MB; use the secure direct upload flow.";});
        file.on("end",()=>{zip=Buffer.concat(chunks);});
      });
      bb.on("field",(name,value)=>{if(name==="output")output=value;});
      bb.on("error",reject);
      bb.on("finish",resolve);
    });
    req.pipe(bb);
    await parsed;
    if (failed) throw new Error(failed);
    if (!zip) throw new Error("Missing project ZIP.");
    return json(res,202,await startBuild(zip,output));
  } catch (error) {
    return json(res,400,{error:error?.message || "Build could not be started."});
  }
}
