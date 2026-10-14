import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import worker from "../worker.mjs";
import migrations from "../generated/migrations.mjs";
import { MIN_TOKEN_LENGTH } from "../admin-token.mjs";
import { SqliteD1, migrate } from "./sqlite-d1.mjs";

// Runs the Cloudflare Worker in a container: same routes, UI, admin area, and SQL,
// with SQLite in place of D1 and an admin token in place of Cloudflare Access.

const CLEANUP_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024 + 64 * 1024;

export function serverConfig(env = process.env) {
  const listen = env.PASTE_LISTEN || ":8080";
  const separator = listen.lastIndexOf(":");
  const port = Number(listen.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PASTE_LISTEN: ${listen}`);
  let adminToken = (env.PASTE_ADMIN_TOKEN || "").trim();
  if (!adminToken && env.PASTE_ADMIN_TOKEN_FILE) adminToken = readFileSync(env.PASTE_ADMIN_TOKEN_FILE, "utf8").trim();
  if (adminToken && adminToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`PASTE_ADMIN_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters; generate one with: openssl rand -hex 32`);
  }
  let publicUrl = null;
  if (env.PASTE_PUBLIC_URL) {
    publicUrl = new URL(env.PASTE_PUBLIC_URL);
    if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.pathname !== "/") {
      throw new Error("PASTE_PUBLIC_URL must be an http(s) origin without a path, such as https://paste.example.com");
    }
  }
  return {
    host: separator > 0 ? listen.slice(0, separator).replace(/^\[|\]$/g, "") : undefined,
    port,
    dataDir: env.PASTE_DATA_DIR || "/var/lib/paste",
    publicUrl,
    // Only headers your own proxy overwrites, e.g. "X-Forwarded-For" or "CF-Connecting-IP".
    trustedHeaders: (env.PASTE_TRUSTED_HEADERS || "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean),
    revision: env.BUILD_REVISION || "development",
    workerEnv: {
      DEFAULT_TTL: env.PASTE_DEFAULT_TTL || "2592000",
      ENABLE_MERMAID: env.PASTE_ENABLE_MERMAID || "false",
      UI_LINE_NUMBERS: env.PASTE_UI_LINE_NUMBERS || "false",
      PASTE_ADMIN_TOKEN: adminToken,
    },
  };
}

export function clientIP(incoming, trustedHeaders) {
  for (const name of trustedHeaders) {
    const value = incoming.headers[name];
    if (!value) continue;
    const first = (Array.isArray(value) ? value[0] : value).split(",")[0].trim();
    const clean = /^\[([^\]]+)\](?::\d+)?$/.exec(first)?.[1] || (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(first) ? first.split(":")[0] : first);
    if (isIP(clean)) return clean;
  }
  const peer = incoming.socket.remoteAddress?.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
  return peer && isIP(peer) ? peer : "";
}

async function readBody(incoming) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    // The Worker enforces the configured limit (413); excess bytes are drained, not buffered,
    // so the client still receives that response.
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createPasteServer(config, database) {
  const env = { ...config.workerEnv, DB: database };
  return createServer({ requestTimeout: 60_000, headersTimeout: 10_000, maxHeaderSize: 16384 }, async (incoming, outgoing) => {
    try {
      if (!incoming.url.startsWith("/")) { outgoing.writeHead(400); outgoing.end(); return; }
      if (incoming.url === "/healthz" || incoming.url === "/health") {
        database.prepare("SELECT 1").execute();
        outgoing.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        outgoing.end(JSON.stringify({ status: "ok", revision: config.revision }) + "\n");
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      // Never trust Cloudflare's identity headers from clients; this server sets the IP itself.
      headers.delete("cf-access-jwt-assertion");
      headers.set("CF-Connecting-IP", clientIP(incoming, config.trustedHeaders));
      const trustProto = config.trustedHeaders.length > 0 && incoming.headers["x-forwarded-proto"] === "https";
      const origin = config.publicUrl
        ? config.publicUrl.origin
        : `${incoming.socket.encrypted || trustProto ? "https" : "http"}://${incoming.headers.host || "localhost"}`;
      const method = incoming.method || "GET";
      const body = ["GET", "HEAD"].includes(method) ? undefined : await readBody(incoming);
      const request = new Request(origin + incoming.url, { method, headers, body });
      const response = await worker.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      outgoing.end("Internal server error.");
    }
  });
}

export async function startServer(processEnv = process.env) {
  const config = serverConfig(processEnv);
  mkdirSync(config.dataDir, { recursive: true });
  const database = new SqliteD1(join(config.dataDir, "paste.sqlite3"));
  const applied = migrate(database, migrations);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  const env = { ...config.workerEnv, DB: database };
  const cleanup = () => worker.scheduled({}, env, { waitUntil: (promise) => promise.catch(() => console.error("Expired paste cleanup failed.")) });
  cleanup();
  const timer = setInterval(cleanup, CLEANUP_MS);
  timer.unref();
  const server = createPasteServer(config, database);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); });
  console.log(`Paste listening on ${config.host || "*"}:${config.port}; admin ${config.workerEnv.PASTE_ADMIN_TOKEN ? "token sign-in enabled" : "disabled (set PASTE_ADMIN_TOKEN)"}`);
  const stop = () => server.close(() => { clearInterval(timer); database.close(); process.exit(0); });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return { server, database, config };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startServer().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
