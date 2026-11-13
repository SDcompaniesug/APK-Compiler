# APK Compiler

A Vercel-hosted Android Gradle build service. Users upload a ZIP containing a Java, Kotlin, or mixed Android Gradle project and receive a debug APK, debug AAB, or both.

## Live service

- Web uploader: https://apk-compiler-sdcompaniesugs-projects.vercel.app/
- Health: https://apk-compiler-sdcompaniesugs-projects.vercel.app/health
- MCP endpoint: https://apk-compiler-sdcompaniesugs-projects.vercel.app/api/mcp
- GitHub: https://github.com/SDcompaniesug/APK-Compiler

## Architecture

- Vercel Node.js controller routes the web UI, upload signing, job status, MCP tools, and downloads.
- Browser uploads ZIPs directly to the project's private Vercel Blob store using a short-lived signed PUT URL.
- Each build runs in its own named Vercel Sandbox microVM restored from an Android SDK snapshot.
- Build output is written to private Blob storage and streamed through the download endpoint.
- Build jobs are addressed by random 32-character IDs.

## Supported workflow

1. Open the web uploader and choose a project ZIP (maximum 50 MB).
2. Choose Debug APK, Debug AAB, or Both.
3. The browser uploads directly to private Blob storage.
4. The service starts an isolated Gradle build and shows queued/building/complete/failed status.
5. Download the generated APK and/or AAB when the job completes.

## API

- POST /api/upload-url — JSON filename; returns a short-lived private Blob upload URL and pathname.
- PUT uploadUrl — upload ZIP bytes directly to Blob storage with Content-Type: application/zip.
- POST /api/build — JSON pathname and output (apk, aab, or both).
- GET /api/status?id=jobId — job state and artifact download paths.
- GET /api/download?id=jobId&file=apk|aab — streams the private artifact.
- POST /api/mcp — MCP JSON-RPC endpoint exposing start_android_build, get_android_build_status, and apk_compiler_info.

## Required Vercel configuration

- BLOB_READ_WRITE_TOKEN: connected private Blob store.
- ANDROID_BUILD_SNAPSHOT_ID: snapshot containing Java 17, Android SDK platform/build tools, and Gradle 8.7.
- Vercel Sandbox OIDC access for the project.
- Node.js 22 runtime.

The Android build snapshot is a separately managed Vercel Sandbox snapshot. Refresh the snapshot and update ANDROID_BUILD_SNAPSHOT_ID before its expiry.

## Security and limits

- ZIP uploads are constrained to 50 MB; expanded contents are constrained to 500 MB.
- ZIP paths are checked before extraction.
- Builds execute inside isolated Firecracker microVMs, not in the Vercel Function process.
- Blob storage is private; artifact downloads pass through the service.
- Debug builds only. Release signing and keystore handling are intentionally not supported.
- Treat uploaded Android Gradle build scripts as untrusted code.
