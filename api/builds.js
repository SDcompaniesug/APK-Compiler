import { neon } from "@neondatabase/serverless";
import { getBuild, json } from "./_shared.js";

export default async function handler(req,res) {
  if (req.method !== "GET") return json(res,405,{error:"Use GET."});
  try {
    if (!process.env.DATABASE_URL) throw new Error("Neon database is not configured.");
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(
      "SELECT id,state,output_kind,error,artifacts,created_at,updated_at FROM build_jobs ORDER BY created_at DESC LIMIT 50"
    );
    const builds = await Promise.all(rows.map(async row => {
      let current = row;
      if (row.state === "queued" || row.state === "building") {
        try { current = { ...row, ...(await getBuild(row.id)) }; }
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