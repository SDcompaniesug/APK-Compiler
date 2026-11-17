import { json, receiveUpload } from "./_shared.js";
import { requireAuth } from "./_auth.js";
export const config={api:{bodyParser:false}};
export default async function handler(req,res){
  if(req.method!=="PUT")return json(res,405,{error:"Use PUT."});
  try{
    const user=await requireAuth(req);
    await receiveUpload(req.query?.pathname,req,res,user.id);
  }catch(error){
    if(!res.headersSent)return json(res,error.statusCode||400,{error:error.message||"Upload failed."});
    res.destroy(error);
  }
}
