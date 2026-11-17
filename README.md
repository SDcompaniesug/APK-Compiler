# APK Compiler

APK Compiler builds Android Gradle, Java, Kotlin, Jetpack Compose, and Flutter projects uploaded as ZIP files. This branch contains the Railway migration.

## Railway architecture

- **API service:** Node.js HTTP server serving the existing web UI and API routes.
- **Build worker:** separate Railway service using an Android SDK + Flutter image. It polls the existing Neon `build_jobs` queue and runs one build at a time.
- **Database:** existing Neon PostgreSQL project `apk-compiler-storage`; existing auth and build tables are retained.
- **Files:** existing private Neon Object Storage bucket `apk-compiler-files`; uploads and APK/AAB artifacts remain there.
- **GitHub:** source remains in `SDcompaniesug/APK-Compiler`; deploy the `railway-migration` branch.

The Vercel Sandbox dependency and snapshot requirement are removed. The API enqueues builds; it does not run Gradle inside an HTTP request.

## Services

### API service
Use the repository root with Railway's Railpack builder. Start command: `npm start`. Public URL: `https://apk-compiler-api-production.up.railway.app`. It serves `public/index.html`, all `/api/*` routes, and `/health`.

### Worker service
Use the same repository and branch, with Dockerfile path `worker/Dockerfile`. It starts with `node worker.js`. Keep worker replicas at **1** initially; it processes one job at a time.

## Required environment variables

Set these on the API service:

- `DATABASE_URL` — Neon PostgreSQL connection string.
- `AUTH_JWT_SECRET` — random secret of at least 32 bytes; keep it stable across restarts.
- `AWS_ACCESS_KEY_ID` — Neon Object Storage scoped credential API token.
- `AWS_SECRET_ACCESS_KEY` — matching S3 secret from the same Neon credential.
- `AWS_ENDPOINT_URL_S3` — Neon S3 endpoint for the production branch.
- `AWS_REGION` — Neon storage region.
- `AWS_BUCKET` — `apk-compiler-files`.

Set the database and storage variables on the worker service too. The worker does not need `AUTH_JWT_SECRET`. Railway supplies `PORT` and `RAILWAY_PUBLIC_DOMAIN`.

## Deploy

1. Create an API service from `SDcompaniesug/APK-Compiler`, branch `railway-migration`, using the repository root and Railpack builder.
2. Create a worker service from the same repository and branch; set Dockerfile path to `worker/Dockerfile`.
3. Add the required variables to both services.
4. Keep worker replicas at 1.
5. Test `/health`, account registration/login, upload, APK build, status polling, and download.
6. Keep Vercel running until the complete end-to-end test succeeds.

## Build safety

Uploaded Gradle and Flutter projects are untrusted code. The worker runs build commands as an unprivileged `builder` OS user, strips Railway/Neon credentials from the build subprocess environment, and processes one job at a time. This is credential separation, **not** a Firecracker microVM boundary; it is not equivalent to Vercel Sandbox isolation. Only build projects you trust, and do not include secrets or signing keys in uploaded projects.

## Limits and behavior

- Project ZIP: 50 MB maximum.
- Expanded project: 500 MB maximum; unsafe paths and suspicious compression ratios are rejected.
- One active build per worker replica.
- Debug and release Gradle/Flutter tasks are supported; release signing depends on the uploaded project's own signing configuration.
- Build artifacts remain private and are served through authenticated download routes.
