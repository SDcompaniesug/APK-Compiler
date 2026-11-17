import { json } from "./_shared.js";
export default async function handler(req,res) {
  if(req.method!=="GET")return json(res,405,{error:"Use GET."});
  return json(res,200,{name:"APK Compiler",status:"online",platform:"Railway",worker:"queued-builds"});
}
