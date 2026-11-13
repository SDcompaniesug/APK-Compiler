import { randomUUID } from "node:crypto";
import { put, get, del } from "@vercel/blob";
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
   *) echo '{"state":"failed","error":"Unsupported output format."}' > "$BASE/status.json"; exit 2 ;;
  esac
 fi
 if [ "$RC" -eq 0 ]; then
  [ -f build/app/outputs/flutter-apk/app-debug.apk ] && cp build/app/outputs/flutter-apk/app-debug.apk "$BASE/output/flutter-debug.apk"
  [ -f build/app/outputs/bundle/debug/app-debug.aab ] && cp build/app/outputs/bundle/debug/app-debug.aab "$BASE/output/flutter-debug.aab"
 fi
else
 cd "$ROOT"
 GRADLE_CMD=()
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
  *) echo '{"state":"failed","error":"Unsupported output format."}' > "$BASE/status.json"; exit 2;;
 esac
 "${GRADLE_CMD[@]}" --no-daemon "${TASKS[@]}" > "$BASE/build.log" 2>&1 || RC=$?
 if [ "$RC" -eq 0 ]; then
  find "$ROOT" -path '*/build/outputs/apk/debug/*.apk' -type f -exec cp {} "$BASE/output/" \;
  find "$ROOT" -path '*/build/outputs/bundle/debug/*.aab' -type f -exec cp {} "$BASE/output/" \;
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
import json,glob
a=glob.glob('/vercel/sandbox/output/*.apk')
b=glob.glob('/vercel/sandbox/output/*.aab')
if not a and not b:
 open('/vercel/sandbox/status.json','w').write(json.dumps({'state':'failed','error':'Build completed but no debug APK or AAB artifact was found.'}))
else:
 open('/vercel/sandbox/status.json','w').write(json.dumps({'state':'complete','apk':a[0] if a else None,'aab':b[0] if b else None}))
PY
`;

export async function startBuild(zip, output = "apk") {
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Vercel Blob is not configured.");
  const snapshotId = process.env.ANDROID_BUILD_SNAPSHOT_ID;
  if (!snapshotId) throw new Error("Android build snapshot is not configured.");
  if (!["apk", "aab", "both"].includes(output)) throw new Error("Output must be apk, aab, or both.");
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > 50 * 1024 * 1024) throw new Error("Project ZIP must be between 22 bytes and 50 MB.");
  const id = newId();
  const name = "apk-build-" + id;
  const sandbox = await Sandbox.create({
    name,
    source: { type: "snapshot", snapshotId },
    runtime: "node24",
    region: "iad1",
    resources: { vcpus: 4, memory: 8192 },
    timeout: 45 * 60 * 1000,
    persistent: false,
    networkPolicy: "allow-all"
  });
  try {
    await sandbox.writeFiles([
      { path: "/vercel/sandbox/input/project.zip", content: zip },
      { path: "/vercel/sandbox/status.json", content: Buffer.from(JSON.stringify({ state: "queued" })) },
      { path: "/vercel/sandbox/run-build.sh", content: Buffer.from(buildScript), mode: 0o755 }
    ]);
    await sandbox.runCommand({ cmd: "bash", args: ["/vercel/sandbox/run-build.sh"], detached: true, env: { OUTPUT_KIND: output }, timeoutMs: 45 * 60 * 1000 });
    await put("jobs/" + id + ".json", JSON.stringify({ id, name, output, createdAt: new Date().toISOString() }), {
      access: "private", contentType: "application/json", addRandomSuffix: false,
      allowOverwrite: true
    });
    return { jobId: id, state: "queued", statusUrl: "/api/status?id=" + id };
  } catch (error) {
    try { await sandbox.stop(); } catch {}
    throw error;
  }
}


export async function startBuildFromBlob(pathname, output = "apk") {
  if (typeof pathname !== "string" || !/^uploads\/[a-f0-9]{32}\.zip$/.test(pathname)) throw new Error("Invalid uploaded project reference.");
  const blob = await get(pathname, { access: "private" });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw new Error("Uploaded project ZIP was not found.");
  const chunks = [];
  let size = 0;
  const reader = blob.stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 50 * 1024 * 1024) throw new Error("Project ZIP exceeds 50 MB.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const zip = Buffer.concat(chunks, size);
  const job = await startBuild(zip, output);
  try { await del(pathname, { access: "private" }); } catch {}
  return job;
}


async function readPrivateJson(pathname) {
  try {
    const blob = await get(pathname, { access: "private" });
    if (!blob || blob.statusCode !== 200 || !blob.stream) return null;
    const chunks = [];
    const reader = blob.stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function saveBuildResult(id, result) {
  await put("results/" + id + ".json", JSON.stringify(result), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true
  });
  return result;
}

export async function getBuild(id) {
  if (!/^[a-f0-9]{32}$/.test(id || "")) throw new Error("Invalid job ID.");
  const cached = await readPrivateJson("results/" + id + ".json");
  if (cached) return cached;

  const sandbox = await Sandbox.get({ name: "apk-build-" + id, resume: true });
  const raw = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/status.json" });
  if (!raw) return { jobId: id, state: "queued" };
  const state = JSON.parse(raw.toString("utf8"));

  if (state.state === "failed") {
    const result = await saveBuildResult(id, { jobId: id, state: "failed", error: state.error || "Build failed." });
    try { await sandbox.stop(); } catch {}
    return result;
  }
  if (state.state !== "complete") return { jobId: id, ...state };

  const artifacts = {};
  for (const key of ["apk", "aab"]) {
    if (!state[key]) continue;
    const file = await sandbox.readFileToBuffer({ path: state[key] });
    if (!file?.length) continue;
    const blob = await put("builds/" + id + "/" + key + (key === "apk" ? ".apk" : ".aab"), file, {
      access: "private",
      contentType: key === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream",
      addRandomSuffix: false,
      allowOverwrite: true
    });
    artifacts[key] = { url: blob.url, size: file.length };
  }

  const result = Object.keys(artifacts).length
    ? {
        jobId: id,
        state: "complete",
        artifacts: Object.fromEntries(
          Object.entries(artifacts).map(([key, value]) => [
            key,
            { ...value, url: "/api/download?id=" + id + "&file=" + key }
          ])
        )
      }
    : { jobId: id, state: "failed", error: "Build completed but no APK or AAB artifact could be read." };

  await saveBuildResult(id, result);
  try { await sandbox.stop(); } catch {}
  return result;
}
