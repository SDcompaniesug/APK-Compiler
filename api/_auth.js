import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { neon } from "@neondatabase/serverless";

const scrypt = promisify(scryptCallback);
const ISSUER = "apk-compiler";
const AUDIENCE = "apk-compiler-android";
const ACCESS_SECONDS = 15 * 60;
const REFRESH_DAYS = 30;

function db() {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error("Authentication database is not configured."), { statusCode: 503 });
  return neon(process.env.DATABASE_URL);
}
function secret() {
  const value = process.env.AUTH_JWT_SECRET || "";
  if (Buffer.byteLength(value) < 32) throw Object.assign(new Error("Authentication is temporarily unavailable."), { statusCode: 503 });
  return value;
}
const b64 = value => Buffer.from(value).toString("base64url");
const sha256 = value => createHash("sha256").update(value).digest("hex");

function signAccess(user, sessionId) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({
    iss: ISSUER, aud: AUDIENCE, sub: user.id, sid: sessionId,
    email: user.email, name: user.name, iat: now, exp: now + ACCESS_SECONDS
  }));
  const input = head + "." + body;
  return input + "." + createHmac("sha256", secret()).update(input).digest("base64url");
}
function verifyAccess(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const input = parts[0] + "." + parts[1];
    const expected = createHmac("sha256", secret()).update(input).digest();
    const actual = Buffer.from(parts[2], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== ISSUER || payload.aud !== AUDIENCE || !payload.sub || !payload.sid || !Number.isInteger(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch { return null; }
}
async function issueSession(user) {
  const sql = db();
  const id = randomUUID();
  const refreshToken = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 86400000).toISOString();
  await sql.query(
    "INSERT INTO public.auth_sessions (id,user_id,refresh_token_hash,expires_at) VALUES ($1,$2,$3,$4)",
    [id, user.id, sha256(refreshToken), expiresAt]
  );
  return { accessToken: signAccess(user, id), refreshToken, user: { id: user.id, name: user.name, email: user.email } };
}
export async function registerAccount(name, email, password) {
  const cleanName = String(name || "").trim().slice(0, 80);
  const cleanEmail = String(email || "").trim().toLowerCase();
  const pass = String(password || "");
  if (cleanName.length < 2 || cleanName.length > 80) throw Object.assign(new Error("Enter a name between 2 and 80 characters."), { statusCode: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) throw Object.assign(new Error("Enter a valid email address."), { statusCode: 400 });
  if (pass.length < 8 || pass.length > 128) throw Object.assign(new Error("Password must be at least 8 characters."), { statusCode: 400 });
  const platform = await db().query("SELECT registration_enabled,maintenance_mode FROM public.compiler_admin_settings WHERE id=1");
  if (platform[0]?.maintenance_mode || platform[0]?.registration_enabled === false) throw Object.assign(new Error("New registrations are temporarily disabled."), { statusCode: 503 });
  const salt = randomBytes(16);
  const derived = await scrypt(pass, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const passwordHash = "scrypt$" + salt.toString("base64url") + "$" + Buffer.from(derived).toString("base64url");
  const user = { id: randomUUID(), email: cleanEmail, name: cleanName };
  try {
    await db().query(
      "INSERT INTO public.app_users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)",
      [user.id, user.email, user.name, passwordHash]
    );
  } catch (error) {
    if (error?.code === "23505") throw Object.assign(new Error("An account with this email already exists."), { statusCode: 409 });
    throw error;
  }
  return issueSession(user);
}
export async function loginAccount(email, password) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const rows = await db().query(
    "SELECT id,email,name,password_hash,status FROM public.app_users WHERE email=$1 LIMIT 1",
    [cleanEmail]
  );
  const row = rows[0];
  let valid = false;
  if (row && typeof row.password_hash === "string") {
    const parts = row.password_hash.split("$");
    if (parts.length === 3 && parts[0] === "scrypt") {
      try {
        const salt = Buffer.from(parts[1], "base64url");
        const expected = Buffer.from(parts[2], "base64url");
        const actual = Buffer.from(await scrypt(String(password || ""), salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
        valid = expected.length === actual.length && timingSafeEqual(expected, actual);
      } catch { valid = false; }
    }
  }
  if (!valid) throw Object.assign(new Error("Incorrect email or password."), { statusCode: 401 });
  if (row.status && row.status !== "active") throw Object.assign(new Error("This account is suspended or banned."), { statusCode: 403 });
  return issueSession({ id: row.id, email: row.email, name: row.name });
}
export async function rotateRefreshToken(refreshToken) {
  const token = String(refreshToken || "");
  if (token.length < 40 || token.length > 256) throw Object.assign(new Error("Your session expired. Please sign in again."), { statusCode: 401 });
  const nextToken = randomBytes(48).toString("base64url");
  const rows = await db().query(
    "UPDATE public.auth_sessions SET refresh_token_hash=$1,last_used_at=now() WHERE refresh_token_hash=$2 AND revoked_at IS NULL AND expires_at>now() RETURNING id,user_id",
    [sha256(nextToken), sha256(token)]
  );
  if (!rows.length) throw Object.assign(new Error("Your session expired. Please sign in again."), { statusCode: 401 });
  const users = await db().query(
    "SELECT id,email,name FROM public.app_users WHERE id=$1 LIMIT 1",
    [rows[0].user_id]
  );
  if (!users.length) throw Object.assign(new Error("Your session expired. Please sign in again."), { statusCode: 401 });
  const user = users[0];
  return { accessToken: signAccess(user, rows[0].id), refreshToken: nextToken, user: { id: user.id, name: user.name, email: user.email } };
}
export async function revokeRefreshToken(refreshToken) {
  const token = String(refreshToken || "");
  if (!token) return;
  await db().query(
    "UPDATE public.auth_sessions SET revoked_at=now() WHERE refresh_token_hash=$1 AND revoked_at IS NULL",
    [sha256(token)]
  );
}
export async function requireAuth(req) {
  const header = String(req.headers?.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  const claims = match ? verifyAccess(match[1]) : null;
  if (!claims) throw Object.assign(new Error("Authentication required. Please sign in."), { statusCode: 401 });
  const rows = await db().query(
    "SELECT s.id,u.id AS user_id,u.email,u.name,u.status FROM public.auth_sessions s JOIN public.app_users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() LIMIT 1",
    [claims.sid, claims.sub]
  );
  if (!rows.length) throw Object.assign(new Error("Your session is no longer valid. Please sign in again."), { statusCode: 401 });
  if (rows[0].status && rows[0].status !== "active") throw Object.assign(new Error("This account is suspended or banned."), { statusCode: 403 });
  return { id: rows[0].user_id, email: rows[0].email, name: rows[0].name, sessionId: rows[0].id };
}
