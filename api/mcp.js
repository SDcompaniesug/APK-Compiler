import { json, startBuild, getBuild } from "./_shared.js";
export const config={api:{bodyParser:true}};
const tools=[
 {name:"start_android_build",description:"Start an isolated Android Gradle build from a base64-encoded project ZIP. Supports Java, Kotlin and mixed projects; debug APK, AAB or both. ZIP maximum 50 MB.",inputSchema:{type:"object",properties:{project_zip_base64:{type:"string",description:"Base64-encoded .zip file"},output:{type:"string",enum:["apk","aab","both"],default:"apk"}},required:["project_zip_base64"]}},
 {name:"get_android_build_status",description:"Check an Android build job and receive download URLs when complete.",inputSchema:{type:"object",properties:{job_id:{type:"string"}},required:["job_id"]}},
 {name:"apk_compiler_info",description:"Get service capabilities and build constraints.",inputSchema:{type:"object",properties:{}}}
];
function result(obj){return {jsonrpc:"2.0",id:obj.id??null,result:{content:[{type:"text",text:JSON.stringify(obj.data)}],structuredContent:obj.data}}}
export default async function handler(req,res){
 if(req.method==="GET") return json(res,200,{name:"APK Compiler",version:"1.0.0",tools:tools.map(t=>t.name),status:"online"});
 if(req.method!=="POST") return json(res,405,{error:"Method not allowed"});
 try{
  const body=req.body||{};const id=body.id??null;
  if(body.method==="initialize") return json(res,200,{jsonrpc:"2.0",id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"apk-compiler",version:"1.0.0"}}});
  if(body.method==="notifications/initialized") return res.end();
  if(body.method==="ping") return json(res,200,{jsonrpc:"2.0",id,result:{}});
  if(body.method==="tools/list") return json(res,200,{jsonrpc:"2.0",id,result:{tools}});
  if(body.method==="tools/call"){
   const name=body.params?.name,args=body.params?.arguments||{};
   if(name==="apk_compiler_info") return json(res,200,result({id,data:{service:"APK Compiler",formats:["debug APK","debug AAB"],languages:["Java","Kotlin"],maxZipMB:50,signing:"debug only",status:"online"}}));
   if(name==="start_android_build"){
    const zip=Buffer.from(args.project_zip_base64||"","base64");
    const job=await startBuild(zip,args.output||"apk");
    return json(res,200,result({id,data:job}));
   }
   if(name==="get_android_build_status"){
    const data=await getBuild(args.job_id);
    return json(res,200,result({id,data}));
   }
   return json(res,200,{jsonrpc:"2.0",id,error:{code:-32601,message:"Unknown tool"}});
  }
  return json(res,200,{jsonrpc:"2.0",id,error:{code:-32601,message:"Unsupported method"}});
 }catch(e){return json(res,200,{jsonrpc:"2.0",id:body?.id??null,error:{code:-32000,message:e.message||"Internal error"}})}
}
