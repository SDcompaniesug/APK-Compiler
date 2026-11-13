import { getBuild, json } from "./_shared.js";
export default async function handler(req,res) {
  if(req.method!=="GET") return json(res,405,{error:"Use GET."});
  try { const result=await getBuild(req.query?.id); return json(res,200,result); }
  catch(e) { return json(res,404,{error:e.message||"Build not found."}); }
}
