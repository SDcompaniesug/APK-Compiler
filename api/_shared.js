import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { Sandbox } from "@vercel/sandbox";

export const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
};
export const readJson = async (req) => {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
export const newId = () => randomUUID().replaceAll("-", "");
export async function startBuild(zip, output = "apk") {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Blob storage is not configured.");
  if (!process.env.ANDROID_BUILD_SNAPSHOT_ID) throw new Error("Android build image is not configured. Set ANDROID_BUILD_SNAPSHOT_ID to the provisioned SDK snapshot.");
  if (!["apk","aab","both"].includes(output)) throw new Error("Output must be apk, aab, or both.");
  if (!zip?.length || zip.length > 50 * 1024 * 1024) throw new Error("Project ZIP must be between 1 byte and 50 MB.");
  const id = newId();
  const name = "apk-build-" + id.slice(0, 24);
  const sandbox = await Sandbox.create({
    name, source:{type:"snapshot",snapshotId:process.env.ANDROID_BUILD_SNAPSHOT_ID},
    resources:{vcpus:2}, timeout:45*60*1000, persistent:true, region:"iad1"
  });
  await sandbox.writeFiles([{path:"/vercel/sandbox/input/project.zip",content:zip}]);
  const script = `#!/usr/bin/env bash
set +e
cd /vercel/sandbox
mkdir -p work output
python3 - <<'PY'
import zipfile, os, sys
z=zipfile.ZipFile('/vercel/sandbox/input/project.zip')
total=0
for i in z.infolist():
    n=i.filename.replace('\\\\','/')
    if n.startswith('/') or any(p=='..' for p in n.split('/')) or i.is_dir() and i.file_size:
        raise SystemExit('Unsafe ZIP entry: '+n)
    total += i.file_size
    if total > 500*1024*1024: raise SystemExit('Expanded project exceeds 500 MB')
    if i.file_size and i.compress_size and i.file_size/i.compress_size > 200: raise SystemExit('Suspicious compression ratio')
z.extractall('/vercel/sandbox/work')
PY
if [ $? -ne 0 ]; then echo '{"state":"failed","error":"Project ZIP validation or extraction failed."}' > status.json; exit 1; fi
ROOT=/vercel/sandbox/work
if [ ! -f "$ROOT/settings.gradle" ] && [ ! -f "$ROOT/settings.gradle.kts" ]; then
  dirs=$(find "$ROOT" -mindepth 2 -maxdepth 3 \\( -name settings.gradle -o -name settings.gradle.kts \\) -print -quit)
  if [ -n "$dirs" ]; then ROOT=$(dirname "$dirs"); fi
fi
if [ ! -f "$ROOT/settings.gradle" ] && [ ! -f "$ROOT/settings.gradle.kts" ]; then echo '{"state":"failed","error":"No Gradle Android project (settings.gradle or settings.gradle.kts) found."}' > /vercel/sandbox/status.json; exit 1; fi
cd "$ROOT"
export ANDROID_HOME=/root/android-sdk ANDROID_SDK_ROOT=/root/android-sdk
export JAVA_HOME=$(dirname $(dirname $(readlink -f $(command -v java))))
GRADLE=./gradlew
if [ ! -x "$GRADLE" ]; then GRADLE=gradle; fi
ARGS=""
case "${OUTPUT_KIND}" in apk) ARGS="assembleDebug";; aab) ARGS="bundleDebug";; both) ARGS="assembleDebug bundleDebug";; esac
echo '{"state":"building"}' > /vercel/sandbox/status.json
$GRADLE --no-daemon $ARGS > /vercel/sandbox/build.log 2>&1
RC=$?
if [ $RC -ne 0 ]; then tail -c 12000 /vercel/sandbox/build.log > /vercel/sandbox/build-error.txt; python3 - <<'PY'
import json
e=open('/vercel/sandbox/build-error.txt',errors='replace').read()
open('/vercel/sandbox/status.json','w').write(json.dumps({'state':'failed','error':e[-10000:]}))
PY
exit $RC
fi
mkdir -p /vercel/sandbox/output
find "$ROOT" -path '*/build/outputs/apk/debug/*.apk' -type f -exec cp {} /vercel/sandbox/output/ \\;
find "$ROOT" -path '*/build/outputs/bundle/debug/*.aab' -type f -exec cp {} /vercel/sandbox/output/ \\;
python3 - <<'PY'
import json,glob,os
a=glob.glob('/vercel/sandbox/output/*.apk'); b=glob.glob('/vercel/sandbox/output/*.aab')
open('/vercel/sandbox/status.json','w').write(json.dumps({'state':'complete','apk':a[0] if a else None,'aab':b[0] if b else None}))
PY
`;
  await sandbox.writeFiles([{path:"/vercel/sandbox/run-build.sh",content:Buffer.from(script),mode:0o755},{path:"/vercel/sandbox/status.json",content:Buffer.from(JSON.stringify({state:"queued"}))}]);
  const command = await sandbox.runCommand({cmd:"bash",args:["/vercel/sandbox/run-build.sh"],env:{OUTPUT_KIND:output},detached:true});
  const record = {id,name,commandId:command.commandId || command.id || null,output,createdAt:new Date().toISOString()};
  await put(`jobs/${id}.json`,JSON.stringify(record),{access:"public",contentType:"application/json",addRandomSuffix:false});
  return {jobId:id,state:"queued",statusUrl:`/api/status?id=${id}`};
}
export async function getBuild(id) {
  if (!/^[a-f0-9]{32}$/.test(id||"")) throw new Error("Invalid job ID.");
  const { Sandbox: S } = await import("@vercel/sandbox");
  const sandbox = await S.get({name:"apk-build-"+id.slice(0,24)});
  const buf = await sandbox.readFileToBuffer({path:"/vercel/sandbox/status.json"});
  const state = JSON.parse(buf?.toString("utf8") || '{"state":"queued"}');
  if (state.state !== "complete") return {jobId:id,...state};
  const artifacts = {};
  for (const key of ["apk","aab"]) {
    if (!state[key]) continue;
    const file = await sandbox.readFileToBuffer({path:state[key]});
    if (!file) continue;
    const blob = await put(`builds/${id}/${key}.${key}`,file,{access:"public",contentType:key==="apk"?"application/vnd.android.package-archive":"application/octet-stream",addRandomSuffix:false});
    artifacts[key]={url:blob.url,size:file.length};
  }
  return {jobId:id,state:"complete",artifacts};
}
