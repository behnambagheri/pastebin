// Discovery documents and the MCP server that let AI agents find and use Paste.

const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const JSON_TYPE = "application/json";
const ID_PATTERN = "^[A-Za-z0-9_-]+$";

/** Links advertised on every response so agents can find the machine-readable docs. */
export const DISCOVERY_LINK = [
  '</llms.txt>; rel="describedby"; type="text/markdown"',
  '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
  '</.well-known/api-catalog>; rel="api-catalog"',
].join(", ");

// Paste pages are private by link: crawlers must not consume burn-after-reading pastes.
export const ROBOTS = `User-agent: *
Allow: /$
Allow: /new
Allow: /usage
Allow: /llms.txt
Allow: /openapi.json
Allow: /.well-known/
Disallow: /
`;

export function apiCatalog(origin) {
  return {
    linkset: [{
      anchor: `${origin}/`,
      "service-desc": [{ href: `${origin}/openapi.json`, type: "application/vnd.oai.openapi+json" }],
      "service-doc": [
        { href: `${origin}/llms.txt`, type: "text/markdown" },
        { href: `${origin}/usage`, type: "text/plain" },
      ],
    }],
  };
}

const idParameter = { name: "id", in: "path", required: true, schema: { type: "string", pattern: ID_PATTERN } };
const pasteSchema = {
  type: "object",
  required: ["id", "url", "raw_url", "download_url", "lang", "size", "burn", "encrypted", "expires_at"],
  properties: {
    id: { type: "string" },
    url: { type: "string", format: "uri", description: "Highlighted web view for people." },
    raw_url: { type: "string", format: "uri", description: "Plain-text contents." },
    download_url: { type: "string", format: "uri" },
    lang: { type: "string" },
    size: { type: "integer", description: "Size in bytes." },
    burn: { type: "boolean", description: "Deleted after the first read." },
    encrypted: { type: "boolean" },
    expires_at: { type: ["string", "null"], format: "date-time", description: "Null when the paste never expires." },
  },
};
const textError = (description) => ({ description, content: { "text/plain": { schema: { type: "string" } } } });
const contents = (description) => ({
  description,
  content: { "text/plain": { schema: { type: "string" } }, "application/octet-stream": { schema: { type: "string", format: "binary" } } },
});

export function openApi(origin, limits) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Paste",
      version: "1.0.0",
      description: `Share text, code, and files by link. No authentication; anyone with a link can read or delete the paste. Pastes are limited to ${limits.maxSize}; without ttl a paste expires after ${limits.defaultExpiry}. An MCP server is available at ${origin}/mcp.`,
    },
    servers: [{ url: origin }],
    paths: {
      "/": {
        post: {
          operationId: "createPaste",
          summary: "Create a paste from the raw request body",
          parameters: [
            { name: "ttl", in: "query", schema: { type: "integer", minimum: 0 }, description: `Seconds until expiry; 0 never expires when allowed. Default: ${limits.defaultExpiry}.` },
            { name: "burn", in: "query", schema: { type: "boolean", default: false }, description: "Delete the paste after it is read once." },
            { name: "lang", in: "query", schema: { type: "string", default: "markup" }, description: "Highlighting language for the web view, e.g. bash, python, json." },
            { name: "encrypted", in: "query", schema: { type: "boolean", default: false }, description: "Marks content encrypted by the web editor; the server does not encrypt." },
          ],
          requestBody: {
            required: true,
            description: "The paste contents, sent as-is (not form-encoded).",
            content: { "text/plain": { schema: { type: "string" } }, "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          responses: {
            200: {
              description: "The new paste. Send Accept: application/json for the JSON object; otherwise the body is its URL.",
              content: { [JSON_TYPE]: { schema: pasteSchema }, "text/plain": { schema: { type: "string", format: "uri" } } },
            },
            413: textError("The paste exceeds the size limit."),
            422: textError("A query parameter is invalid."),
            503: textError("Creation is disabled for maintenance."),
          },
        },
      },
      "/raw/{id}": {
        get: {
          operationId: "getPasteRaw",
          summary: "Read a paste as plain text (consumes burn-after-reading pastes)",
          parameters: [idParameter],
          responses: { 200: { description: "The contents.", content: { "text/plain": { schema: { type: "string" } } } }, 404: { description: "Missing, expired, or already read." } },
        },
      },
      "/download/{id}": {
        get: {
          operationId: "downloadPaste",
          summary: "Download a paste (consumes burn-after-reading pastes)",
          parameters: [idParameter],
          responses: { 200: contents("The contents."), 404: { description: "Missing, expired, or already read." } },
        },
      },
      "/{id}": {
        get: {
          operationId: "viewPaste",
          summary: "Highlighted HTML view for people; agents should use /raw/{id}",
          parameters: [idParameter, { name: "lang", in: "query", schema: { type: "string" } }],
          responses: { 200: { description: "HTML page.", content: { "text/html": {} } }, 404: { description: "Not found." } },
        },
        delete: {
          operationId: "deletePaste",
          summary: "Delete a paste",
          parameters: [idParameter],
          responses: { 200: { description: "Deleted, or it did not exist." } },
        },
      },
      "/usage": {
        get: {
          operationId: "getUsage",
          summary: "Plain-text command-line guide",
          responses: { 200: { description: "The guide.", content: { "text/plain": { schema: { type: "string" } } } } },
        },
      },
    },
  };
}

// ---- MCP (Streamable HTTP, stateless, JSON responses) ----

const TOOLS = [
  {
    name: "create_paste",
    title: "Create paste",
    description: "Upload text to Paste and get a shareable link. Anyone with the link can read or delete it, so do not upload secrets unless the user asks to. Give the user `url`.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string", description: "The text to share." },
        lang: { type: "string", description: "Highlighting language, e.g. bash, python, json, diff, markdown. Default: markup." },
        ttl: { type: "integer", minimum: 0, description: "Seconds until the paste expires; 0 never expires when allowed. Omit for the server default." },
        burn: { type: "boolean", description: "Delete the paste after it is read once." },
      },
      additionalProperties: false,
    },
    outputSchema: pasteSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "read_paste",
    title: "Read paste",
    description: "Read a paste's text by ID or link. Reading a burn-after-reading paste deletes it.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "Paste ID or its link, e.g. https://…/abc or https://…/raw/abc." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "delete_paste",
    title: "Delete paste",
    description: "Delete a paste by ID or link.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "Paste ID or its link." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

/** Accepts a bare ID or any Paste link (/<id>, /raw/<id>, /download/<id>, /new?id=<id>). */
function pasteId(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  try {
    const link = new URL(candidate);
    candidate = link.searchParams.get("id") || link.pathname.split("/").filter(Boolean).pop() || "";
  } catch { /* Not a URL: treat it as an ID. */ }
  return new RegExp(ID_PATTERN).test(candidate) ? candidate : null;
}

const toolText = (text, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args, context) {
  const { api, env, origin } = context;
  if (!TOOLS.some((tool) => tool.name === name)) return null;
  if (name === "create_paste") {
    if (typeof args.content !== "string") return toolText("`content` must be a string.", true);
    const params = new URLSearchParams();
    if (args.lang !== undefined) params.set("lang", String(args.lang));
    if (args.ttl !== undefined) params.set("ttl", String(args.ttl));
    if (args.burn !== undefined) params.set("burn", String(args.burn));
    const paste = await api.store(env, params, new TextEncoder().encode(args.content), origin, context.meta);
    return { content: [{ type: "text", text: JSON.stringify(paste) }], structuredContent: paste };
  }
  const id = pasteId(args.id);
  if (!id) return toolText("`id` must be a paste ID or link.", true);
  if (name === "read_paste") {
    const paste = await api.load(id, env);
    if (!paste) return toolText(`Paste ${id} does not exist, has expired, or was already read.`, true);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(paste.bytes);
    } catch {
      return toolText(`Paste ${id} is binary (${paste.bytes.length} bytes); download it from ${origin}/download/${id}.`, true);
    }
    const content = [{ type: "text", text }];
    if (paste.encrypted) content.push({ type: "text", text: "Note: this paste was encrypted in the browser; the text above is ciphertext and needs the password." });
    if (paste.burn) content.push({ type: "text", text: "Note: this was a burn-after-reading paste and has now been deleted." });
    return { content };
  }
  const deleted = await api.remove(id, env);
  return toolText(deleted ? `Deleted paste ${id}.` : `Paste ${id} did not exist.`);
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleMessage(message, context) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    // Responses from the client need no reply; anything else is malformed.
    return message && ("result" in message || "error" in message) ? undefined : rpcError(message?.id, -32600, "Invalid request.");
  }
  if (!("id" in message)) return undefined;
  const { id, method } = message;
  const params = message.params || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return ok({
        protocolVersion: MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "paste", title: "Paste", version: "1.0.0", websiteUrl: `${context.origin}/` },
        instructions: `Paste shares text by link. create_paste returns a url for the user. Anyone with a link can read or delete the paste. Limits: ${context.limits.maxSize}; default expiry ${context.limits.defaultExpiry}.`,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      try {
        const result = await callTool(params.name, args, context);
        return result ? ok(result) : rpcError(id, -32602, `Unknown tool: ${params.name}`);
      } catch (error) {
        // Validation, size, and maintenance errors are reported to the model, not as protocol errors.
        if (error.status) return ok(toolText(error.message, true));
        throw error;
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Handles /mcp. `api` provides store/load/remove from the Worker; `readBody` enforces the size limit.
 * There is no session state, so GET (server-initiated streams) and DELETE (session end) return 405.
 */
export async function mcpResponse(request, context, respond) {
  if (request.method !== "POST") {
    return respond(null, 405, undefined, { Allow: "POST" });
  }
  const json = (value, status = 200) => respond(JSON.stringify(value), status, JSON_TYPE);
  const version = request.headers.get("MCP-Protocol-Version");
  if (version && !MCP_VERSIONS.includes(version)) return json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${version}`), 400);
  let message;
  try {
    message = JSON.parse(new TextDecoder().decode(await context.readBody()));
  } catch (error) {
    if (error.status) throw error;
    return json(rpcError(null, -32700, "Parse error."), 400);
  }
  if (Array.isArray(message)) return json(rpcError(null, -32600, "Batch requests are not supported."), 400);
  const reply = await handleMessage(message, context);
  return reply === undefined ? respond(null, 202) : json(reply);
}
