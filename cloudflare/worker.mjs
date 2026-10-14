import Handlebars from "handlebars/runtime.js";
import templateSpec from "./generated/template.mjs";
import assets, { versions } from "./generated/assets.mjs";

Handlebars.registerHelper("format_url", (prefix, url) => url.startsWith("/") ? prefix + url : url);
Handlebars.registerHelper("not", (value) => !value);
Handlebars.registerHelper("or", (left, right) => left || right);
const render = Handlebars.template(templateSpec);
const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const SLUG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const expiryOptions = [
  ["5 minutes", 300], ["10 minutes", 600], ["1 hour", 3600],
  ["1 day", 86400], ["1 week", 604800], ["1 month", 2630016],
  ["1 year", 31557600], ["Never", 0],
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function response(body, status = 200, type = "text/plain; charset=utf-8", extra = {}) {
  return new Response(body, { status, headers: {
    "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", ...extra,
  } });
}

function lang(value) {
  const lowered = (value || "markup").toLowerCase();
  return /^[a-z0-9_+#-]+$/.test(lowered) ? lowered : "markup";
}

function flag(params, key) {
  const value = params.get(key);
  if (value === null || value === "false" || value === "0") return 0;
  if (value === "true" || value === "1") return 1;
  throw new HttpError(422, `Invalid ${key} value.`);
}

function ttl(params, env) {
  const value = params.get("ttl") ?? env.DEFAULT_TTL ?? "0";
  if (!/^\d+$/.test(value)) throw new HttpError(422, "Invalid ttl value.");
  const seconds = Number(value);
  // Keep expiry values within JavaScript's exact integer range.
  if (!Number.isSafeInteger(seconds) || seconds > Number.MAX_SAFE_INTEGER - Math.floor(Date.now() / 1000)) {
    throw new HttpError(422, "Invalid ttl value.");
  }
  return seconds;
}

function encode(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

function decode(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readBody(request) {
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > MAX_BYTES) throw new HttpError(413, "Maximum paste size is 8 MiB.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "Maximum paste size is 8 MiB.");
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return body;
}

async function create(request, env, url) {
  const seconds = ttl(url.searchParams, env);
  const burn = flag(url.searchParams, "burn");
  const encrypted = flag(url.searchParams, "encrypted");
  const data = await readBody(request);
  const random = crypto.getRandomValues(new Uint8Array(21));
  const id = Array.from(random, (value) => SLUG_ALPHABET[value & 63]).join("");
  const now = Math.floor(Date.now() / 1000);
  const statements = [env.DB.prepare(
    "INSERT INTO pastes (id, lang, created_at, expires_at, burn, encrypted) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, lang(url.searchParams.get("lang")), now, seconds ? now + seconds : 0, burn, encrypted)];
  // Separate rows preserve the Rust app's 8 MiB limit within D1's 2 MB row limit.
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
    statements.push(env.DB.prepare("INSERT INTO paste_chunks (paste_id, chunk_index, data) VALUES (?, ?, ?)")
      .bind(id, offset / CHUNK_BYTES, encode(data.subarray(offset, offset + CHUNK_BYTES))));
  }
  await env.DB.batch(statements);
  return response(`${url.origin}/${id}`);
}

async function load(id, env, consume = true) {
  const now = Math.floor(Date.now() / 1000);
  const statements = [
    env.DB.prepare("DELETE FROM pastes WHERE id = ? AND expires_at > 0 AND expires_at <= ?").bind(id, now),
    env.DB.prepare("SELECT * FROM pastes WHERE id = ?").bind(id),
    env.DB.prepare("SELECT data FROM paste_chunks WHERE paste_id = ? ORDER BY chunk_index").bind(id),
  ];
  if (consume) statements.push(env.DB.prepare("DELETE FROM pastes WHERE id = ? AND burn = 1").bind(id));
  // D1 batches are transactions: competing readers cannot both claim a burn paste.
  const results = await env.DB.batch(statements);
  const paste = results[1].results[0];
  if (!paste) return null;
  const parts = results[2].results.map((row) => decode(row.data));
  paste.bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { paste.bytes.set(part, offset); offset += part.length; }
  return paste;
}

// Content-hashed query strings keep day-long static caching safe across deploys.
function versioned(asset) { return `${asset}?v=${versions[asset]}`; }

function page(env, values = {}, status = 200) {
  const defaultTtl = Number(env.DEFAULT_TTL || 0);
  const options = [...expiryOptions];
  if (!options.some(([, seconds]) => seconds === defaultTtl)) options.push([`${defaultTtl} seconds`, defaultTtl]);
  const data = {
    version: "0.2.0", uri_prefix: "", ui_expiry_times: options,
    ui_expiry_default: options.find(([, seconds]) => seconds === defaultTtl)[0],
    css_imports: ["/static/style.css", "/static/prism.css"].map(versioned),
    js_imports: ["/static/custom.js", "/static/prism.js"].map(versioned),
    js_init: ["var holder = document.getElementById('pastebin-code-block'); if (holder) { Prism.highlightElement(holder); }"],
    ...values,
  };
  if (env.ENABLE_MERMAID === "true") {
    data.js_imports.push("https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.12.0/mermaid.min.js");
    data.js_init.push("mermaid.initialize({startOnLoad: false}); mermaid.run({querySelector: '.language-mermaid'});");
  }
  return response(render(data), status, "text/html; charset=utf-8");
}

function missing(env) { return page(env, { is_error: true }, 404); }

async function route(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;
  if (method === "POST" && path === "/") return create(request, env, url);
  if (method === "DELETE" && /^\/[A-Za-z0-9_-]+$/.test(path)) {
    await env.DB.prepare("DELETE FROM pastes WHERE id = ?").bind(path.slice(1)).run();
    return response(null);
  }
  if (method !== "GET" && method !== "HEAD") return response("Method not allowed.", 405, undefined, { Allow: "GET, HEAD, POST, DELETE" });
  if (path === "/") return response(null, 303, undefined, { Location: "/new" });
  if (path.startsWith("/static/")) {
    const asset = assets[path];
    if (!asset) return missing(env);
    const types = { css: "text/css; charset=utf-8", js: "application/javascript; charset=utf-8", ico: "image/x-icon", html: "text/html; charset=utf-8" };
    return response(decode(asset), 200, types[path.split(".").pop()] || "application/octet-stream", { "Cache-Control": "public, max-age=86400" });
  }
  if (path === "/new") {
    const params = url.searchParams;
    const values = { is_editable: true, level: params.get("level") || "secondary", glyph: params.get("glyph") || "", msg: params.get("msg") || "" };
    const link = params.get("url");
    if (link) {
      try {
        const parsed = new URL(link, url);
        if (parsed.origin === url.origin && ["http:", "https:"].includes(parsed.protocol)) values.url = parsed.href;
      } catch { /* Invalid links are omitted from the notice. */ }
    }
    if (params.has("id")) {
      const paste = await load(params.get("id"), env, method !== "HEAD");
      if (!paste) return missing(env);
      values.pastebin_code = new TextDecoder().decode(paste.bytes);
      values.is_encrypted = Boolean(paste.encrypted);
    }
    return page(env, values);
  }
  const match = /^\/(?:(raw|download)\/)?([A-Za-z0-9_-]+)$/.exec(path);
  if (!match) return missing(env);
  const [, format, id] = match;
  const paste = await load(id, env, method !== "HEAD");
  if (!paste) return format ? response(null, 404) : missing(env);
  if (format) return response(paste.bytes, 200, format === "raw" ? "text/plain; charset=utf-8" : "application/octet-stream");
  const selectedLang = lang(url.searchParams.get("lang") ?? paste.lang);
  const values = {
    is_created: true, pastebin_id: id, pastebin_code: new TextDecoder().decode(paste.bytes),
    pastebin_cls: `${env.UI_LINE_NUMBERS === "true" ? "line-numbers " : ""}language-${selectedLang}`,
    is_encrypted: Boolean(paste.encrypted),
  };
  if (paste.burn) Object.assign(values, {
    msg: "FOR YOUR EYES ONLY. The paste is gone, after you close this window.",
    level: "warning", is_burned: true, glyph: "fa fa-fire",
  });
  else if (paste.expires_at) Object.assign(values, {
    msg: `This paste will expire on ${new Date(paste.expires_at * 1000).toISOString().slice(0, 19).replace("T", " ")}.`,
    level: "info", glyph: "far fa-clock",
  });
  return page(env, values);
}

export default {
  async fetch(request, env) {
    try {
      const result = await route(request, env);
      return request.method === "HEAD" ? new Response(null, result) : result;
    } catch (error) {
      if (error instanceof HttpError) return response(error.message, error.status);
      // Do not log paste bodies, encryption material, or paste URLs.
      console.error("Paste request failed.");
      return response("Internal server error.", 500);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(env.DB.prepare(
      "DELETE FROM pastes WHERE id IN (SELECT id FROM pastes WHERE expires_at > 0 AND expires_at <= ? LIMIT 1000)"
    ).bind(Math.floor(Date.now() / 1000)).run());
  },
};
