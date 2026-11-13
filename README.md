# APK Compiler

Private staging service for compiling Android Gradle project ZIPs into debug APK and/or AAB artifacts.

## Architecture
- Vercel Node.js API and MCP JSON-RPC endpoint.
- Vercel Sandbox microVMs isolate untrusted Gradle builds.
- Vercel Blob stores completed build artifacts.
- Each build receives a unique sandbox and job ID.

## Requirements
Set `BLOB_READ_WRITE_TOKEN`. Deploy with Vercel Sandbox OIDC enabled for the project. The Android build image is created from the provisioned Android SDK snapshot configured by `ANDROID_BUILD_SNAPSHOT_ID`.

## API
- `POST /api/build` multipart fields: `project` (ZIP), `output` (`apk`, `aab`, `both`)
- `GET /api/status?id=<jobId>` status and artifact URLs
- `POST /api/mcp` MCP JSON-RPC `tools/list` and `tools/call`

Debug builds only. No release signing. ZIPs are validated and compiled in isolated Vercel Sandboxes.
