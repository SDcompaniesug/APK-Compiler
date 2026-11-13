import { json, startBuild, startBuildFromBlob, getBuild } from "./_shared.js";

export const config = { api: { bodyParser: true } };

const tools = [
  {
    name: "start_android_build",
    description: "Start an isolated Android build from a base64 project ZIP or private Blob upload. Supports Java, Kotlin, Jetpack Compose and Flutter projects; debug APK, AAB or both. ZIP maximum 50 MB.",
    inputSchema: {
      type: "object",
      properties: {
        project_zip_base64: { type: "string", description: "Base64-encoded .zip file" },
        project_blob_path: { type: "string", description: "Private Blob pathname returned by the direct upload flow" },
        output: { type: "string", enum: ["apk", "aab", "both"], default: "apk" }
      },
      anyOf: [{ required: ["project_zip_base64"] }, { required: ["project_blob_path"] }]
    }
  },
  {
    name: "get_android_build_status",
    description: "Check an Android build job and receive download URLs when complete.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] }
  },
  {
    name: "apk_compiler_info",
    description: "Get service capabilities and build constraints.",
    inputSchema: { type: "object", properties: {} }
  }
];

function result(id, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data
    }
  };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return json(res, 200, {
      name: "APK Compiler",
      version: "1.1.0",
      tools: tools.map(tool => tool.name),
      status: "online"
    });
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const body = req.body || {};
  const id = body.id ?? null;
  try {
    if (body.method === "initialize") {
      return json(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "apk-compiler", version: "1.1.0" }
        }
      });
    }
    if (body.method === "notifications/initialized") return res.end();
    if (body.method === "ping") return json(res, 200, { jsonrpc: "2.0", id, result: {} });
    if (body.method === "tools/list") return json(res, 200, { jsonrpc: "2.0", id, result: { tools } });

    if (body.method === "tools/call") {
      const name = body.params?.name;
      const args = body.params?.arguments || {};
      if (name === "apk_compiler_info") {
        return json(res, 200, result(id, {
          service: "APK Compiler",
          formats: ["debug APK", "debug AAB"],
          languages: ["Java", "Kotlin", "Dart"],
          frameworks: ["Android Gradle", "Jetpack Compose", "Flutter"],
          maxZipMB: 50,
          maxExpandedMB: 500,
          signing: "debug only",
          status: "online"
        }));
      }
      if (name === "start_android_build") {
        const output = args.output || "apk";
        const job = args.project_blob_path
          ? await startBuildFromBlob(args.project_blob_path, output)
          : await startBuild(Buffer.from(args.project_zip_base64 || "", "base64"), output);
        return json(res, 200, result(id, job));
      }
      if (name === "get_android_build_status") {
        const data = await getBuild(args.job_id);
        return json(res, 200, result(id, data));
      }
      return json(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Unknown tool" }
      });
    }
    return json(res, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Unsupported method" }
    });
  } catch (error) {
    return json(res, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: error?.message || "Internal error" }
    });
  }
}
