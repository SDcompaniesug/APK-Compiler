import { neon } from "@neondatabase/serverless";
import { S3Client, HeadBucketCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { json } from "./_shared.js";

export default async function handler(req,res) {
  if (req.method !== "GET") return json(res,405,{error:"Use GET."});
  try {
    const required = ["DATABASE_URL","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_ENDPOINT_URL_S3","AWS_REGION","AWS_BUCKET"];
    for (const key of required) if (!process.env[key]) throw new Error("Missing server configuration: "+key);
    const sql = neon(process.env.DATABASE_URL);
    await sql`SELECT 1 AS ready`;
    const s3 = new S3Client({
      region:process.env.AWS_REGION,
      endpoint:process.env.AWS_ENDPOINT_URL_S3,
      forcePathStyle:true,
      credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}
    });
    await s3.send(new HeadBucketCommand({Bucket:process.env.AWS_BUCKET}));
    await s3.send(new PutBucketCorsCommand({
      Bucket:process.env.AWS_BUCKET,
      CORSConfiguration:{CORSRules:[{
        AllowedOrigins:["https://apk-compiler-sdcompaniesugs-projects.vercel.app","https://apk-compiler-ten.vercel.app"],
        AllowedMethods:["PUT","HEAD"],
        AllowedHeaders:["*"],
        ExposeHeaders:["ETag"],
        MaxAgeSeconds:3600
      }]}
    }));
    return json(res,200,{status:"ready",database:"connected",objectStorage:"connected",bucketAccess:"private"});
  } catch (error) {
    console.error("Backend readiness check failed:",error);
    return json(res,503,{status:"not_ready",error:"Database or private object storage could not be reached."});
  }
}
