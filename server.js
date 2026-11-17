import http from "node:http";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root=path.dirname(fileURLToPath(import.meta.url));
const routes=new Map([
  ["/api/upload-url","./api/upload-url.js"],
  ["/api/build","./api/build.js"],
  ["/api/status","./api/status.js"],
  ["/api/download","./api/download.js"],
  ["/api/builds","./api/builds.js"],
  ["/api/icon","./api/icon.js"],
  ["/api/mcp","./api/mcp.js"],
  ["/api/auth/login","./api/auth/login.js"],
  ["/api/auth/register","./api/auth/register.js"],
  ["/api/auth/refresh","./api/auth/refresh.js"],
  ["/api/auth/logout","./api/auth/logout.js"],
  ["/api/health","./api/health.js"],
  ["/health","./api/health.js"]
]);
async function readJson(req,limit=2*1024*1024) {
  const chunks=[];let size=0;
  for await (const chunk of req) { size+=chunk.length;if(size>limit)throw Object.assign(new Error("Request body is too large."),{statusCode:413});chunks.push(chunk); }
  if(!size)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
  catch{throw Object.assign(new Error("Invalid JSON request body."),{statusCode:400});}
}
async function staticFile(res,pathname) {
  let target=pathname==="/"?"index.html":decodeURIComponent(pathname).replace(/^\/+/, "");
  if(target.includes("\\")||target.split("/").some(p=>p===".."||p.startsWith(".")))return false;
  const full=path.resolve(root,"public",target);
  if(!full.startsWith(path.resolve(root,"public")+path.sep))return false;
  try{
    const info=await stat(full);if(!info.isFile())return false;
    const data=await readFile(full);
    const ext=path.extname(full).toLowerCase();
    const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg",".webp":"image/webp",".ico":"image/x-icon"};
    res.statusCode=200;res.setHeader("content-type",types[ext]||"application/octet-stream");res.setHeader("cache-control",ext===".html"?"no-cache":"public, max-age=3600");res.end(data);return true;
  }catch{return false;}
}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,"http://localhost");
    req.query=Object.fromEntries(url.searchParams.entries());
    if(req.method==="OPTIONS"){res.statusCode=204;res.setHeader("access-control-allow-methods","GET,POST,PUT,DELETE,OPTIONS");res.setHeader("access-control-allow-headers","authorization,content-type,range");return res.end();}
    const route=routes.get(url.pathname);
    if(route){
      if((req.headers["content-type"]||"").includes("application/json") && req.method!=="GET")req.body=await readJson(req);
      const mod=await import(route);return await mod.default(req,res);
    }
    if(req.method==="GET" && await staticFile(res,url.pathname))return;
    res.statusCode=404;res.setHeader("content-type","application/json; charset=utf-8");res.end(JSON.stringify({error:"Not found."}));
  }catch(error){
    if(!res.headersSent){res.statusCode=error.statusCode||500;res.setHeader("content-type","application/json; charset=utf-8");res.end(JSON.stringify({error:error.message||"Internal server error."}));}
    else res.destroy(error);
  }
});
const port=Number(process.env.PORT||3000);
server.listen(port,"0.0.0.0",()=>console.log("APK Compiler API listening on "+port));
