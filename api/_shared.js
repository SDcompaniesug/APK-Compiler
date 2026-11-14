import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Sandbox } from "@vercel/sandbox";

export function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(data));
}
export const newId = () => randomUUID().replaceAll("-", "");

const buildScript = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
BASE=/vercel/sandbox
ANDROID_HOME=$(printenv ANDROID_HOME || true)
ANDROID_SDK_ROOT=$(printenv ANDROID_SDK_ROOT || true)
trap 'rc=$?; if [ ! -f "$BASE/status.json" ] || ! grep -q failed "$BASE/status.json"; then echo "{\"state\":\"failed\",\"error\":\"Build runner exited with code $rc\"}" > "$BASE/status.json"; fi' ERR
mkdir -p "$BASE/work" "$BASE/output"
: > "$BASE/build.log"
python3 - <<'PY'
import zipfile, os, json
src='/vercel/sandbox/input/project.zip'
dst='/vercel/sandbox/work'
try:
 z=zipfile.ZipFile(src)
 total=0
 for i in z.infolist():
  n=i.filename.replace('\\','/')
  parts=n.split('/')
  if n.startswith('/') or (parts and ':' in parts[0]) or '..' in parts:
   raise ValueError('Unsafe ZIP entry: '+n)
  total+=i.file_size
  if total>500*1024*1024: raise ValueError('Expanded project exceeds 500 MB')
  if i.file_size and i.compress_size and i.file_size/i.compress_size>200:
   raise ValueError('Suspicious ZIP compression ratio')
 z.extractall(dst)
except Exception as e:
 open('/vercel/sandbox/status.json','w').write(json.dumps({'state':'failed','error':'ZIP validation failed: '+str(e)}))
 raise SystemExit(2)
PY
ROOT="$BASE/work"
FLUTTER_PUBSPEC=$(find "$ROOT" -maxdepth 7 -type f -name pubspec.yaml -print -quit)
BUILD_KIND=gradle
if [ -n "$FLUTTER_PUBSPEC" ]; then
 ROOT=$(dirname "$FLUTTER_PUBSPEC")
 BUILD_KIND=flutter
else
 SETTINGS=$(find "$ROOT" -maxdepth 7 -type f \( -name settings.gradle -o -name settings.gradle.kts \) -print -quit)
 if [ -z "$SETTINGS" ]; then
  echo '{"state":"failed","error":"No Gradle settings file or Flutter pubspec.yaml was found in the ZIP."}' > "$BASE/status.json"
  exit 2
 fi
 ROOT=$(dirname "$SETTINGS")
fi
SDK=""
for CANDIDATE in "$ANDROID_HOME" "$ANDROID_SDK_ROOT" "$HOME/android-sdk" /home/vercel-sandbox/android-sdk /root/android-sdk /opt/android-sdk; do
 if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE/platform-tools/adb" ] && [ -d "$CANDIDATE/platforms" ]; then SDK="$CANDIDATE"; break; fi
done
if [ -z "$SDK" ]; then
 SDK=$(find "$HOME" /home/vercel-sandbox /root /opt -maxdepth 6 -type f -name sdkmanager -print -quit 2>/dev/null | sed 's#/cmdline-tools/.*##')
fi
if [ -z "$SDK" ]; then echo '{"state":"failed","error":"Android SDK is missing from the build image."}' > "$BASE/status.json"; exit 2; fi
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
export JAVA_HOME=$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")
export PATH="$JAVA_HOME/bin:$SDK/platform-tools:$PATH"
echo '{"state":"building"}' > "$BASE/status.json"
RC=0
if [ "$BUILD_KIND" = "flutter" ]; then
 SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
 if [ ! -x "$SDKMANAGER" ]; then SDKMANAGER=$(find "$SDK/cmdline-tools" -type f -name sdkmanager -print -quit 2>/dev/null || true); fi
 if [ ! -d "$SDK/platforms/android-36" ] || [ ! -d "$SDK/build-tools/36.0.0" ] || [ ! -d "$SDK/build-tools/28.0.3" ] || [ ! -d "$SDK/ndk/28.2.13676358" ]; then
  if [ ! -x "$SDKMANAGER" ]; then
   echo '{"state":"failed","error":"Flutter requires Android SDK 36 and Android SDK Manager is missing from the build image."}' > "$BASE/status.json"
   exit 2
  fi
  "$SDKMANAGER" --install "platforms;android-36" "build-tools;36.0.0" "build-tools;28.0.3" "ndk;28.2.13676358" >> "$BASE/build.log" 2>&1 || {
   echo '{"state":"failed","error":"Could not install Android SDK 36 / Flutter Android build prerequisites. See build log."}' > "$BASE/status.json"
   exit 2
  }
 fi
 if [ ! -f "$ROOT/android/settings.gradle" ] && [ ! -f "$ROOT/android/settings.gradle.kts" ]; then
  echo '{"state":"failed","error":"Flutter project is missing its android Gradle subproject."}' > "$BASE/status.json"
  exit 2
 fi
 FLUTTER=""
 for CANDIDATE in "$HOME/flutter/bin/flutter" /opt/flutter/bin/flutter /usr/local/flutter/bin/flutter; do
  if [ -x "$CANDIDATE" ]; then FLUTTER="$CANDIDATE"; break; fi
 done
 if [ -z "$FLUTTER" ]; then
  command -v git >/dev/null 2>&1 || { echo '{"state":"failed","error":"Git is required to install the Flutter SDK."}' > "$BASE/status.json"; exit 2; }
  git clone --depth 1 --branch stable https://github.com/flutter/flutter.git "$HOME/flutter" >> "$BASE/build.log" 2>&1 || {
   echo '{"state":"failed","error":"Could not download the Flutter stable SDK. Check sandbox network access and retry."}' > "$BASE/status.json"; exit 2;
  }
  FLUTTER="$HOME/flutter/bin/flutter"
 fi
 export PATH="$(dirname "$FLUTTER"):$PATH"
 "$FLUTTER" config --no-analytics >> "$BASE/build.log" 2>&1 || true
 yes | "$FLUTTER" doctor --android-licenses >> "$BASE/build.log" 2>&1 || true
 cd "$ROOT"
 "$FLUTTER" pub get >> "$BASE/build.log" 2>&1 || RC=$?
 if [ "$RC" -eq 0 ]; then
  case "$OUTPUT_KIND" in
   apk) "$FLUTTER" build apk --debug >> "$BASE/build.log" 2>&1 || RC=$? ;;
   aab) "$FLUTTER" build appbundle --debug >> "$BASE/build.log" 2>&1 || RC=$? ;;
   both)
    "$FLUTTER" build apk --debug >> "$BASE/build.log" 2>&1 || RC=$?
    if [ "$RC" -eq 0 ]; then "$FLUTTER" build appbundle --debug >> "$BASE/build.log" 2>&1 || RC=$?; fi
    ;;
   release-apk) "$FLUTTER" build apk --release >> "$BASE/build.log" 2>&1 || RC=$? ;;
   release-aab) "$FLUTTER" build appbundle --release >> "$BASE/build.log" 2>&1 || RC=$? ;;
   release-both)
    "$FLUTTER" build apk --release >> "$BASE/build.log" 2>&1 || RC=$?
    if [ "$RC" -eq 0 ]; then "$FLUTTER" build appbundle --release >> "$BASE/build.log" 2>&1 || RC=$?; fi
    ;;
   *) echo '{"state":"failed","error":"Unsupported output format."}' > "$BASE/status.json"; exit 2 ;;
  esac
 fi
 if [ "$RC" -eq 0 ]; then
  find build/app/outputs/flutter-apk -maxdepth 1 -type f -name '*.apk' -exec cp {} "$BASE/output/" \; 2>/dev/null || true
  find build/app/outputs/bundle -maxdepth 2 -type f -name '*.aab' -exec cp {} "$BASE/output/" \; 2>/dev/null || true
 fi
else
 cd "$ROOT"
 # Projects exported from AIDE/Termux may hard-code an AAPT2 binary path that
 # exists only on the developer's phone. Remove that machine-specific override
 # so AGP resolves its matching AAPT2 artifact from Maven in the cloud.
 python3 - "$ROOT" "$HOME/.gradle/gradle.properties" <<'PY'
import os,re,sys
root,global_props=sys.argv[1:]
paths=[]
for base,dirs,files in os.walk(root):
 dirs[:] = [d for d in dirs if d not in (".git","build",".gradle")]
 if "gradle.properties" in files:
  paths.append(os.path.join(base,"gradle.properties"))
if os.path.isfile(global_props):
 paths.append(global_props)
pattern=re.compile(r"^\s*(?:(?:systemProp|org\.gradle\.project)\.)?android\.aapt2FromMavenOverride\s*=.*(?:\n|$)",re.M)
for path in paths:
 try:
  with open(path,encoding="utf-8") as f: original=f.read()
  cleaned=pattern.sub("",original)
  if cleaned != original:
   with open(path,"w",encoding="utf-8") as f: f.write(cleaned)
   print("Removed device-specific AAPT2 override from "+path)
 except (OSError,UnicodeError) as e:
  print("Could not inspect "+path+": "+str(e))
PY
 GRADLE_CMD=()
 WRAPPER_PROPS="$ROOT/gradle/wrapper/gradle-wrapper.properties"
 if [ -f ./gradlew ]; then
  chmod +x ./gradlew
  GRADLE_CMD=(./gradlew)
 elif [ -x /tmp/gradle-8.9/bin/gradle ]; then
  GRADLE_CMD=(/tmp/gradle-8.9/bin/gradle)
 else
  mkdir -p /tmp/gradle-8.9
  if [ ! -x /tmp/gradle-8.9/bin/gradle ]; then
   curl -fsSL https://services.gradle.org/distributions/gradle-8.9-bin.zip -o /tmp/gradle-8.9.zip >> "$BASE/build.log" 2>&1 || {
    echo '{"state":"failed","error":"Could not download Gradle 8.9 and the project ZIP does not include gradlew."}' > "$BASE/status.json"
    exit 2
   }
   unzip -q -o /tmp/gradle-8.9.zip -d /tmp >> "$BASE/build.log" 2>&1 || {
    echo '{"state":"failed","error":"Could not extract Gradle 8.9."}' > "$BASE/status.json"
    exit 2
   }
  fi
  GRADLE_CMD=(/tmp/gradle-8.9/bin/gradle)
 fi
 case "$OUTPUT_KIND" in
  apk) TASKS=(assembleDebug);;
  aab) TASKS=(bundleDebug);;
  both) TASKS=(assembleDebug bundleDebug);;
  release-apk) TASKS=(assembleRelease);;
  release-aab) TASKS=(bundleRelease);;
  release-both) TASKS=(assembleRelease bundleRelease);;
  *) echo '{"state":"failed","error":"Unsupported output format."}' > "$BASE/status.json"; exit 2 ;;
 esac
 # First build attempt uses the project's configured wrapper (or fallback Gradle).
 if "${"$"}{GRADLE_CMD[@]}" --no-daemon "${"$"}{TASKS[@]}" > "$BASE/build.log" 2>&1; then
  RC=0
 else
  RC=$?
  # Android Gradle Plugin prints its actual minimum Gradle version. Upgrade only
  # when the wrapper is demonstrably too old, preserving compatibility for older projects.
  REQUIRED_GRADLE=$(python3 - "$BASE/build.log" <<'PY'
import re,sys
s=open(sys.argv[1],errors='replace').read()
m=re.search(r'Minimum supported Gradle version is ([0-9]+(?:\.[0-9]+){1,2})\.\s*Current version is ([0-9]+(?:\.[0-9]+){1,2})',s)
if m:
 def v(x): return tuple(int(p) for p in x.split('.'))
 if v(m.group(1)) > v(m.group(2)): print(m.group(1))
PY
  )
  if [ -n "$REQUIRED_GRADLE" ]; then
   # Run the exact Gradle version required by AGP directly. Re-invoking
   # gradlew after editing its properties can still pick up a stale cached
   # distribution in some wrapper setups, so use the downloaded binary.
   GRADLE_HOME="/tmp/gradle-$REQUIRED_GRADLE"
   mkdir -p "$GRADLE_HOME"
   if [ ! -x "$GRADLE_HOME/bin/gradle" ]; then
    curl -fsSL "https://services.gradle.org/distributions/gradle-$REQUIRED_GRADLE-bin.zip" -o "/tmp/gradle-$REQUIRED_GRADLE.zip" >> "$BASE/build.log" 2>&1 || {
     echo "Could not download required Gradle $REQUIRED_GRADLE." >> "$BASE/build.log"
     RC=1
    }
    if [ "$RC" -eq 0 ]; then
     unzip -q -o "/tmp/gradle-$REQUIRED_GRADLE.zip" -d /tmp >> "$BASE/build.log" 2>&1 || RC=$?
    fi
   fi
   if [ "$RC" -eq 0 ] && [ -x "$GRADLE_HOME/bin/gradle" ]; then
    if [ -f "$WRAPPER_PROPS" ]; then
     python3 - "$WRAPPER_PROPS" "$REQUIRED_GRADLE" <<'PY'
import re,sys
p,v=sys.argv[1],sys.argv[2]
s=open(p,encoding="utf-8").read()
url="https"+chr(92)+"://services.gradle.org/distributions/gradle-"+v+"-bin.zip"
if re.search(r"(?m)^distributionUrl=",s):
 s=re.sub(r"(?m)^distributionUrl=.*$", "distributionUrl="+url, s)
else:
 s += (chr(10) if s and not s.endswith(chr(10)) else "")+"distributionUrl="+url+chr(10)
open(p,"w",encoding="utf-8").write(s)
PY
    fi
    echo "Retrying with Android Gradle Plugin-required Gradle $REQUIRED_GRADLE." >> "$BASE/build.log"
    "$GRADLE_HOME/bin/gradle" --no-daemon "${"$"}{TASKS[@]}" >> "$BASE/build.log" 2>&1 || RC=$?
   fi
  fi
 fi

 if [ "$RC" -eq 0 ]; then
  find "$ROOT" -path '*/build/outputs/apk/*/*.apk' -type f -exec cp {} "$BASE/output/" \;
  find "$ROOT" -path '*/build/outputs/bundle/*/*.aab' -type f -exec cp {} "$BASE/output/" \;
 fi
fi
if [ "$RC" -ne 0 ]; then
 python3 - <<'PY'
p='/vercel/sandbox/build.log'
s=open(p,errors='replace').read()
open('/vercel/sandbox/status.json','w').write(__import__('json').dumps({'state':'failed','error':s[-12000:]}))
PY
 exit "$RC"
fi
python3 - <<'PY'
import json,glob,os,subprocess,re,zipfile,base64
a=glob.glob('/vercel/sandbox/output/*.apk')
b=glob.glob('/vercel/sandbox/output/*.aab')
if not a and not b:
 open('/vercel/sandbox/status.json','w').write(json.dumps({'state':'failed','error':'Build completed but no requested APK or AAB artifact was found.'}))
else:
 meta={}
 if a:
  sdk=os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or ''
  tools=glob.glob(os.path.join(sdk,'build-tools','*','aapt'))
  tools.sort(reverse=True)
  if tools:
   try:
    badging=subprocess.check_output([tools[0],'dump','badging',a[0]],stderr=subprocess.DEVNULL,text=True,timeout=15)
    label=re.search(r"^application-label:'(.*)'$",badging,re.M)
    if label: meta['appName']=label.group(1)[:120]
    icons=re.findall(r"^application-icon-[^:]+:'([^']+)'$",badging,re.M)
    with zipfile.ZipFile(a[0]) as apk:
     for icon in icons:
      try:
       data=apk.read(icon)
       if len(data)<=60000 and (data.startswith(b'\x89PNG') or data.startswith(b'RIFF') or data.startswith(b'\xff\xd8')):
        meta['appIconBase64']=base64.b64encode(data).decode('ascii')
        break
      except Exception: pass
   except Exception: pass
 state={'state':'complete','apk':a[0] if a else None,'aab':b[0] if b else None}
 state.update(meta)
 open('/vercel/sandbox/status.json','w').write(json.dumps(state))
PY
`;


function database() {
  if (!process.env.DATABASE_URL) throw new Error("Neon database is not configured.");
  return neon(process.env.DATABASE_URL);
}
function storage() {
  const required = ["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_ENDPOINT_URL_S3","AWS_REGION","AWS_BUCKET"];
  for (const key of required) if (!process.env[key]) throw new Error("Neon Object Storage is missing " + key + ".");
  return new S3Client({
    region: process.env.AWS_REGION,
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
  });
}
async function streamToBuffer(body, maxBytes = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) throw new Error("Uploaded project ZIP exceeds 50 MB.");
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}
async function ensureBucketCors(client) {
  await client.send(new PutBucketCorsCommand({
    Bucket: process.env.AWS_BUCKET,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: [
          "https://apk-compiler-sdcompaniesugs-projects.vercel.app",
          "https://apk-compiler-ten.vercel.app",
          "https://apk-compiler-j8dr9eirw-sdcompaniesugs-projects.vercel.app"
        ],
        AllowedMethods: ["PUT","HEAD"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3600
      }]
    }
  }));
}
export async function createUpload(id, filename) {
  if (!/\.zip$/i.test(String(filename || ""))) throw new Error("Choose a .zip project file.");
  const key = "uploads/" + id + ".zip";
  const client = storage();
  await ensureBucketCors(client);
  const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET, Key: key, ContentType: "application/zip"
  }), { expiresIn: 900 });
  const sql = database();
  await sql.query(
    "INSERT INTO build_jobs (id,state,output_kind,upload_key,created_at,updated_at,expires_at) VALUES ($1,'queued','apk',$2,now(),now(),now()+interval '24 hours') ON CONFLICT (id) DO UPDATE SET upload_key=EXCLUDED.upload_key,updated_at=now()",
    [id,key]
  );
  return { pathname:key,uploadUrl,validUntil:Date.now()+15*60*1000,maxBytes:50*1024*1024 };
}
export async function startBuild(zip, output = "apk", existingId = null) {
  if (!["apk","aab","both","release-apk","release-aab","release-both"].includes(output)) throw new Error("Choose a supported debug or release output.");
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > 50 * 1024 * 1024) throw new Error("Project ZIP must be between 22 bytes and 50 MB.");
  const id = existingId || newId();
  const name = "apk-build-" + id;
  const sql = database();
  let sandbox;
  try {
    sandbox = await Sandbox.create({
      name,source:{type:"snapshot",snapshotId:process.env.ANDROID_BUILD_SNAPSHOT_ID},
      runtime:"node24",region:"iad1",resources:{vcpus:4,memory:8192},
      timeout:45*60*1000,persistent:false,networkPolicy:"allow-all"
    });
    await sandbox.writeFiles([
      {path:"/vercel/sandbox/input/project.zip",content:zip},
      {path:"/vercel/sandbox/status.json",content:Buffer.from(JSON.stringify({state:"queued"}))},
      {path:"/vercel/sandbox/run-build.sh",content:Buffer.from(buildScript),mode:0o755}
    ]);
    await sandbox.runCommand({cmd:"bash",args:["/vercel/sandbox/run-build.sh"],detached:true,env:{OUTPUT_KIND:output},timeoutMs:45*60*1000});
    await sql.query(
      "INSERT INTO build_jobs (id,state,output_kind,sandbox_name,created_at,updated_at,expires_at) VALUES ($1,'building',$2,$3,now(),now(),now()+interval '7 days') ON CONFLICT (id) DO UPDATE SET state='building',output_kind=EXCLUDED.output_kind,sandbox_name=EXCLUDED.sandbox_name,updated_at=now(),error=NULL",
      [id,output,name]
    );
    return {jobId:id,state:"building",statusUrl:"/api/status?id="+id};
  } catch (error) {
    try { if (sandbox) await sandbox.stop(); } catch {}
    await sql.query("UPDATE build_jobs SET state='failed',error=$1,updated_at=now() WHERE id=$2",[String(error?.message||error).slice(0,12000),id]);
    throw error;
  }
}
export async function startBuildFromBlob(pathname, output = "apk") {
  if (typeof pathname !== "string" || !/^uploads\/[a-f0-9]{32}\.zip$/.test(pathname)) throw new Error("Invalid uploaded project reference.");
  const id = pathname.split("/")[1].replace(/\.zip$/,"");
  const sql = database();
  const rows = await sql.query("SELECT id,state,upload_key FROM build_jobs WHERE id=$1 LIMIT 1",[id]);
  if (!rows.length || rows[0].upload_key !== pathname) throw new Error("Uploaded project was not found or has expired.");
  const client = storage();
  const head = await client.send(new HeadObjectCommand({Bucket:process.env.AWS_BUCKET,Key:pathname}));
  if (!Number.isFinite(head.ContentLength) || head.ContentLength < 22 || head.ContentLength > 50*1024*1024) throw new Error("Uploaded project ZIP must be between 22 bytes and 50 MB.");
  const response = await client.send(new GetObjectCommand({Bucket:process.env.AWS_BUCKET,Key:pathname}));
  const zip = await streamToBuffer(response.Body);
  const job = await startBuild(zip,output,id);
  try { await client.send(new DeleteObjectCommand({Bucket:process.env.AWS_BUCKET,Key:pathname})); } catch {}
  return job;
}
export async function getBuild(id) {
  if (!/^[a-f0-9]{32}$/.test(id || "")) throw new Error("Invalid job ID.");
  const sql = database();
  const rows = await sql.query("SELECT id,state,output_kind,sandbox_name,error,artifacts FROM build_jobs WHERE id=$1 LIMIT 1",[id]);
  if (!rows.length) throw new Error("Build not found.");
  const job = rows[0];
  if (job.state === "complete") return {jobId:id,state:"complete",artifacts:job.artifacts||{}};
  if (job.state === "failed") return {jobId:id,state:"failed",error:job.error||"Build failed."};
  if (!job.sandbox_name) return {jobId:id,state:job.state||"queued"};
  let sandbox;
  try {
    sandbox = await Sandbox.get({name:job.sandbox_name,resume:true});
    const raw = await sandbox.readFileToBuffer({path:"/vercel/sandbox/status.json"});
    if (!raw) return {jobId:id,state:job.state||"building"};
    const state = JSON.parse(raw.toString("utf8"));
    if (state.state === "failed") {
      const error = String(state.error||"Build failed.").slice(0,12000);
      await sql.query("UPDATE build_jobs SET state='failed',error=$1,updated_at=now() WHERE id=$2",[error,id]);
      try { await sandbox.stop(); } catch {}
      return {jobId:id,state:"failed",error};
    }
    if (state.state !== "complete") return {jobId:id,state:state.state||"building"};
    const client = storage();
    const artifacts = {};
    for (const key of ["apk","aab"]) {
      if (!state[key]) continue;
      const file = await sandbox.readFileToBuffer({path:state[key]});
      if (!file?.length) continue;
      const objectKey = "builds/"+id+"/"+key+(key==="apk"?".apk":".aab");
      await client.send(new PutObjectCommand({
        Bucket:process.env.AWS_BUCKET,Key:objectKey,Body:file,
        ContentType:key==="apk"?"application/vnd.android.package-archive":"application/octet-stream"
      }));
      artifacts[key] = {size:file.length,url:"/api/download?id="+id+"&file="+key};
    }
    if (state.appName) artifacts.appName = String(state.appName).slice(0,120);
    if (state.appIconBase64) {
      const icon = Buffer.from(String(state.appIconBase64), "base64");
      if (icon.length > 0 && icon.length <= 60000) {
        const contentType = icon.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
          ? "image/png"
          : icon.subarray(0,4).toString("ascii") === "RIFF" ? "image/webp" : "image/jpeg";
        await client.send(new PutObjectCommand({
          Bucket:process.env.AWS_BUCKET,Key:"builds/"+id+"/icon.img",Body:icon,
          ContentType:contentType,CacheControl:"private, max-age=86400"
        }));
        artifacts.appIcon = {url:"/api/icon?id="+id,contentType};
      }
    }
    if (!Object.keys(artifacts).length) {
      const error = "Build completed but no APK or AAB artifact could be read.";
      await sql.query("UPDATE build_jobs SET state='failed',error=$1,updated_at=now() WHERE id=$2",[error,id]);
      try { await sandbox.stop(); } catch {}
      return {jobId:id,state:"failed",error};
    }
    await sql.query("UPDATE build_jobs SET state='complete',artifacts=$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify(artifacts),id]);
    try { await sandbox.stop(); } catch {}
    return {jobId:id,state:"complete",artifacts};
  } catch (error) {
    if (/not found|does not exist/i.test(String(error?.message||""))) return {jobId:id,state:job.state||"building"};
    throw error;
  }
}
export async function downloadArtifact(id,file,res,rangeHeader = null) {
  if (!/^[a-f0-9]{32}$/.test(id||"") || !["apk","aab"].includes(file)) throw new Error("Invalid artifact request.");
  const sql = database();
  const rows = await sql.query("SELECT state,artifacts FROM build_jobs WHERE id=$1 LIMIT 1",[id]);
  if (!rows.length || rows[0].state!=="complete" || !rows[0].artifacts?.[file]) {
    const error = new Error("Artifact not found."); error.statusCode=404; throw error;
  }
  const key = "builds/"+id+"/"+file+(file==="apk"?".apk":".aab");
  const client = storage();
  const range = typeof rangeHeader === "string" && /^bytes=\d+-\d*$/.test(rangeHeader) ? rangeHeader : undefined;
  const result = await client.send(new GetObjectCommand({Bucket:process.env.AWS_BUCKET,Key:key,...(range ? {Range:range} : {})}));
  res.statusCode = range ? 206 : 200;
  res.setHeader("content-type",file==="apk"?"application/vnd.android.package-archive":"application/octet-stream");
  res.setHeader("content-disposition",'attachment; filename="android-'+file+(file==="apk"?".apk":".aab")+'"');
  res.setHeader("cache-control","private, no-store");
  res.setHeader("x-content-type-options","nosniff");
  res.setHeader("accept-ranges","bytes");
  if (result.ContentLength != null) res.setHeader("content-length",String(result.ContentLength));
  if (result.ContentRange) res.setHeader("content-range",result.ContentRange);
  for await (const chunk of result.Body) {
    if (!res.write(Buffer.from(chunk))) await new Promise(resolve=>res.once("drain",resolve));
  }
  res.end();
}


export async function deleteBuild(id) {
  if (!/^[a-f0-9]{32}$/.test(id || "")) {
    const error = new Error("Invalid build ID."); error.statusCode = 400; throw error;
  }
  const sql = database();
  const rows = await sql.query(
    "SELECT id,state,sandbox_name,upload_key FROM build_jobs WHERE id=$1 LIMIT 1", [id]
  );
  if (!rows.length) {
    const error = new Error("Build not found."); error.statusCode = 404; throw error;
  }
  const job = rows[0];
  if (job.sandbox_name) {
    try {
      const sandbox = await Sandbox.get({ name: job.sandbox_name, resume: true });
      await sandbox.stop();
    } catch {}
  }
  const client = storage();
  const keys = [job.upload_key, "builds/" + id + "/apk.apk", "builds/" + id + "/aab.aab", "builds/" + id + "/icon.img"].filter(Boolean);
  await Promise.all(keys.map(key => client.send(new DeleteObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key }))));
  await sql.query("DELETE FROM build_jobs WHERE id=$1", [id]);
  return { success: true, deleted: id };
}


export async function getAppIcon(id,res) {
  if (!/^[a-f0-9]{32}$/.test(id || "")) {
    const error = new Error("Invalid build ID."); error.statusCode = 400; throw error;
  }
  const sql = database();
  const rows = await sql.query("SELECT state,artifacts FROM build_jobs WHERE id=$1 LIMIT 1",[id]);
  if (!rows.length || rows[0].state !== "complete" || !rows[0].artifacts?.appIcon) {
    const error = new Error("App icon not found."); error.statusCode = 404; throw error;
  }
  const client = storage();
  const result = await client.send(new GetObjectCommand({Bucket:process.env.AWS_BUCKET,Key:"builds/"+id+"/icon.img"}));
  res.statusCode = 200;
  res.setHeader("content-type",rows[0].artifacts.appIcon.contentType || "image/png");
  res.setHeader("cache-control","private, max-age=86400");
  res.setHeader("x-content-type-options","nosniff");
  for await (const chunk of result.Body) {
    if (!res.write(Buffer.from(chunk))) await new Promise(resolve=>res.once("drain",resolve));
  }
  res.end();
}
