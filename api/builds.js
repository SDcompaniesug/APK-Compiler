import { neon } from "@neondatabase/serverless";
import { getBuild, deleteBuild, json } from "../lib/_shared.js";
import { requireAuth } from "../lib/_auth.js";

export default async function handler(req,res) {
  let user;
  try { user = await requireAuth(req); }
  catch (error) { return json(res,error.statusCode || 401,{error:error.message || "Authentication required."}); }
  if (req.method === "DELETE") {
    try {
      const result = await deleteBuild(req.query?.id,user.id);
      return json(res,200,result);
    } catch (error) {
      return json(res,error.statusCode || 500,{error:error?.message || "Could not delete build."});
    }
  }
  if (req.method !== "GET") return json(res,405,{error:"Use GET or DELETE."});
  try {
    if (!process.env.DATABASE_URL) throw new Error("Neon database is not configured.");
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(
      "SELECT id,state,output_kind,error,artifacts,created_at,updated_at FROM build_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50", [user.id]
    );
    const builds = await Promise.all(rows.map(async row => {
      let current = row;
      if (row.state === "queued" || row.state === "building") {
        try { current = { ...row, ...(await getBuild(row.id,user.id)) }; }
        catch (error) { current = { ...row, state:"building" }; }
      }
      return {
        id: row.id,
        state: current.state || row.state,
        output_kind: row.output_kind,
        error: current.error || row.error || null,
        artifacts: current.artifacts || row.artifacts || {},
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    }));
    return json(res,200,{builds});
  } catch (error) {
    return json(res,500,{error:error?.message || "Could not load build history."});
  }
}