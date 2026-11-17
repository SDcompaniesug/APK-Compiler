#!/usr/bin/env bash
set -Eeuo pipefail
BASE=/tmp/apk-compiler-job
ANDROID_HOME=$(printenv ANDROID_HOME || true)
ANDROID_SDK_ROOT=$(printenv ANDROID_SDK_ROOT || true)
trap 'rc=$?; if [ ! -f "$BASE/status.json" ] || ! grep -q failed "$BASE/status.json"; then echo "{\"state\":\"failed\",\"error\":\"Build runner exited with code $rc\"}" > "$BASE/status.json"; fi' ERR
mkdir -p "$BASE/work" "$BASE/output"
: > "$BASE/build.log"
python3 - <<'PY'
import zipfile, os, json
src='/tmp/apk-compiler-job/input/project.zip'
dst='/tmp/apk-compiler-job/work'
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
 open('/tmp/apk-compiler-job/status.json','w').write(json.dumps({'state':'failed','error':'ZIP validation failed: '+str(e)}))
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
# Ignore JAVA_HOME from untrusted project files and discover the actual JDK.
unset JAVA_HOME
JAVA_BIN="$(command -v java || true)"
JAVA_HOME=""
if [ -n "$JAVA_BIN" ]; then
 JAVA_REAL="$(readlink -f "$JAVA_BIN" 2>/dev/null || true)"
 if [ -n "$JAVA_REAL" ]; then
  CANDIDATE_HOME="$(dirname "$(dirname "$JAVA_REAL")")"
  if [ -x "$CANDIDATE_HOME/bin/java" ]; then JAVA_HOME="$CANDIDATE_HOME"; fi
 fi
fi
for CANDIDATE_HOME in /opt/java/openjdk /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/temurin-17-jdk-amd64; do
 if [ -z "$JAVA_HOME" ] && [ -x "$CANDIDATE_HOME/bin/java" ]; then JAVA_HOME="$CANDIDATE_HOME"; fi
done
if [ -z "$JAVA_HOME" ] || [ ! -x "$JAVA_HOME/bin/java" ]; then
 echo '{"state":"failed","error":"Java 17 is missing or invalid in the Railway worker image. The build environment could not locate a usable JDK."}' > "$BASE/status.json"
 exit 2
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$SDK/platform-tools:$PATH"
# Remove Java-home overrides embedded in uploaded projects or custom wrappers.
python3 - "$ROOT" <<'PYJAVA'
import os,re,sys
root=sys.argv[1]
for base,dirs,files in os.walk(root):
 dirs[:] = [d for d in dirs if d not in (".git","build",".gradle")]
 for name in files:
  if name == "gradle.properties":
   p=os.path.join(base,name)
   try:
    with open(p,encoding="utf-8") as f: original=f.read()
    cleaned=re.sub(r"(?m)^\s*(?:org\.gradle\.java\.home|systemProp\.java\.home)\s*=.*(?:\n|$)","",original)
    if cleaned != original:
     with open(p,"w",encoding="utf-8") as f: f.write(cleaned)
     print("Removed project-specific Java home override from "+p)
   except (OSError,UnicodeError): pass
  elif name == "gradlew":
   p=os.path.join(base,name)
   try:
    with open(p,encoding="utf-8") as f: original=f.read()
    cleaned=re.sub(r"(?m)^\s*(?:export\s+)?JAVA_HOME\s*=.*(?:\n|$)","",original)
    if cleaned != original:
     with open(p,"w",encoding="utf-8") as f: f.write(cleaned)
     print("Removed invalid JAVA_HOME assignment from Gradle wrapper "+p)
   except (OSError,UnicodeError): pass
PYJAVA
# Keep Gradle and Kotlin within the worker's memory budget. Uploaded projects
# may request multi-gigabyte heaps or parallel workers, which can cause the
# Railway container to OOM-kill the Gradle daemon during Kotlin compilation.
python3 - "$ROOT" "$HOME/.gradle/gradle.properties" <<'PYMEM'
import os,sys
root,global_props=sys.argv[1:]
settings={
 "org.gradle.jvmargs":"-Xmx768m -XX:MaxMetaspaceSize=384m -Dfile.encoding=UTF-8",
 "org.gradle.workers.max":"1",
 "org.gradle.parallel":"false",
 "org.gradle.caching":"false",
 "kotlin.compiler.execution.strategy":"in-process",
 "kotlin.incremental":"false"
}
def apply(path):
 try:
  with open(path,encoding="utf-8") as f: lines=f.readlines()
 except FileNotFoundError: lines=[]
 except (OSError,UnicodeError): return
 keys=set(settings)
 out=[]
 for line in lines:
  stripped=line.strip()
  key=stripped.split("=",1)[0].strip() if "=" in stripped and not stripped.startswith(("#","!")) else ""
  if key in keys: continue
  out.append(line)
 out.extend(k+"="+v+"\n" for k,v in settings.items())
 os.makedirs(os.path.dirname(path),exist_ok=True)
 with open(path,"w",encoding="utf-8") as f: f.writelines(out)
 print("Applied memory-safe Gradle settings to "+path)
apply(global_props)
for base,dirs,files in os.walk(root):
 dirs[:] = [d for d in dirs if d not in (".git","build",".gradle")]
 if "gradle.properties" in files:
  apply(os.path.join(base,"gradle.properties"))
PYMEM
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
 elif [ -x $BASE/tmp/gradle-8.9/bin/gradle ]; then
  GRADLE_CMD=($BASE/tmp/gradle-8.9/bin/gradle)
 else
  mkdir -p $BASE/tmp/gradle-8.9
  if [ ! -x $BASE/tmp/gradle-8.9/bin/gradle ]; then
   curl -fsSL https://services.gradle.org/distributions/gradle-8.9-bin.zip -o "$BASE/tmp/gradle-8.9.zip" >> "$BASE/build.log" 2>&1 || {
    echo '{"state":"failed","error":"Could not download Gradle 8.9 and the project ZIP does not include gradlew."}' > "$BASE/status.json"
    exit 2
   }
   unzip -q -o "$BASE/tmp/gradle-8.9.zip" -d "$BASE/tmp" >> "$BASE/build.log" 2>&1 || {
    echo '{"state":"failed","error":"Could not extract Gradle 8.9."}' > "$BASE/status.json"
    exit 2
   }
  fi
  GRADLE_CMD=($BASE/tmp/gradle-8.9/bin/gradle)
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
 if "${GRADLE_CMD[@]}" --no-daemon "${TASKS[@]}" > "$BASE/build.log" 2>&1; then
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
   GRADLE_HOME="$BASE/tmp/gradle-$REQUIRED_GRADLE"
   mkdir -p "$GRADLE_HOME"
   if [ ! -x "$GRADLE_HOME/bin/gradle" ]; then
    curl -fsSL "https://services.gradle.org/distributions/gradle-$REQUIRED_GRADLE-bin.zip" -o "$BASE/tmp/gradle-$REQUIRED_GRADLE.zip" >> "$BASE/build.log" 2>&1 || {
     echo "Could not download required Gradle $REQUIRED_GRADLE." >> "$BASE/build.log"
     RC=1
    }
    if [ "$RC" -eq 0 ]; then
     unzip -q -o "$BASE/tmp/gradle-$REQUIRED_GRADLE.zip" -d "$BASE/tmp" >> "$BASE/build.log" 2>&1 || RC=$?
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
    "$GRADLE_HOME/bin/gradle" --no-daemon "${TASKS[@]}" >> "$BASE/build.log" 2>&1 || RC=$?
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
p='/tmp/apk-compiler-job/build.log'
s=open(p,errors='replace').read()
open('/tmp/apk-compiler-job/status.json','w').write(__import__('json').dumps({'state':'failed','error':s[-12000:]}))
PY
 exit "$RC"
fi
python3 - <<'PY'
import json,glob,os,subprocess,re,zipfile,base64
a=glob.glob('/tmp/apk-compiler-job/output/*.apk')
b=glob.glob('/tmp/apk-compiler-job/output/*.aab')
if not a and not b:
 open('/tmp/apk-compiler-job/status.json','w').write(json.dumps({'state':'failed','error':'Build completed but no requested APK or AAB artifact was found.'}))
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
 open('/tmp/apk-compiler-job/status.json','w').write(json.dumps(state))
PY

