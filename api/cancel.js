import { neon } from "@neondatabase/serverless";
import { Sandbox } from "@vercel/sandbox";
import { json } from "../lib/_shared.js";
import { requireAuth } from "../lib/_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Use POST." });
  try {
    const user = await requireAuth(req);
    const id = String(req.body?.id || "");
    if (!/^[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: "Invalid build ID." });
    if (!process.env.DATABASE_URL) throw new Error("Neon database is not configured.");
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(
      "SELECT id,state,sandbox_name FROM build_jobs WHERE id=$1 AND user_id=$2 LIMIT 1",
      [id, user.id]
    );
    if (!rows.length) return json(res, 404, { error: "Build not found." });
    const job = rows[0];
    if (job.state === "complete" || job.state === "failed") {
      return json(res, 409, { error: "This build has already finished.", state: job.state });
    }
    if (job.state === "cancelled") return json(res, 200, { success: true, state: "cancelled" });
    if (job.sandbox_name) {
      try {
        const sandbox = await Sandbox.get({ name: job.sandbox_name, resume: true });
        await sandbox.stop();
      } catch (error) {
        // The sandbox may already have stopped; still mark the owned job cancelled.
      }
    }
    const updated = await sql.query(
      "UPDATE build_jobs SET state='cancelled',error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND state IN ('queued','building') RETURNING id",
      [id, user.id]
    );
    if (!updated.length) {
      const latest = await sql.query("SELECT state FROM build_jobs WHERE id=$1 AND user_id=$2 LIMIT 1", [id, user.id]);
      return json(res, 409, { error: "Build state changed before cancellation completed.", state: latest[0]?.state || "unknown" });
    }
    return json(res, 200, { success: true, state: "cancelled", id });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error?.message || "Could not cancel build." });
  }
}