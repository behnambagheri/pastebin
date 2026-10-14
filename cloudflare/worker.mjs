import Handlebars from "handlebars/runtime.js";
import templateSpec from "./generated/template.mjs";
import assets, { versions } from "./generated/assets.mjs";
import { adminResponse } from "./admin.mjs";
import { DISCOVERY_LINK, ROBOTS, apiCatalog, mcpResponse, openApi } from "./agents.mjs";
import * as settings from "./settings.mjs";

Handlebars.registerHelper("format_url", (prefix, url) => url.startsWith("/") ? prefix + url : url);
Handlebars.registerHelper("not", (value) => !value);
Handlebars.registerHelper("or", (left, right) => left || right);
const render = Handlebars.template(templateSpec);
const CHUNK_BYTES = 1024 * 1024;
const MCP_ENVELOPE_BYTES = 64 * 1024;
const SLUG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const expiryOptions = [
  ["5 minutes", 300], ["10 minutes", 600], ["1 hour", 3600],
  ["1 day", 86400], ["1 week", 604800], ["30 days", 2592000],
  ["1 year", 31557600], ["Never", 0],
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function response(body, status = 200, type = "text/plain; charset=utf-8", extra = {}) {
  return new Response(body, { status, headers: {
    "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", Link: DISCOVERY_LINK, ...extra,
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

function ttl(params, config) {
  const value = params.get("ttl") ?? String(config.default_ttl);
  if (!/^\d+$/.test(value)) throw new HttpError(422, "Invalid ttl value.");
  const seconds = Number(value);
  // Keep expiry values within JavaScript's exact integer range.
  if (!Number.isSafeInteger(seconds) || seconds > Number.MAX_SAFE_INTEGER - Math.floor(Date.now() / 1000)) {
    throw new HttpError(422, "Invalid ttl value.");
  }
  if (config.max_ttl && (seconds === 0 || seconds > config.max_ttl)) {
    throw new HttpError(422, `Pastes must expire within ${config.max_ttl} seconds (ttl=1..${config.max_ttl}).`);
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

async function readBody(request, maxBytes) {
  const tooLarge = `Maximum paste size is ${settings.formatBytes(maxBytes)}.`;
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > maxBytes) throw new HttpError(413, tooLarge);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, tooLarge);
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return body;
}

// Stores a paste; options come from the query string (or MCP arguments mapped onto one).
async function store(env, params, data, origin, meta) {
  const config = await settings.load(env);
  if (config.maintenance) throw new HttpError(503, config.maintenance_message);
  const seconds = ttl(params, config);
  const burn = flag(params, "burn");
  const encrypted = flag(params, "encrypted");
  if (data.length > config.max_bytes) throw new HttpError(413, `Maximum paste size is ${settings.formatBytes(config.max_bytes)}.`);
  const random = crypto.getRandomValues(new Uint8Array(21));
  const id = Array.from(random, (value) => SLUG_ALPHABET[value & 63]).join("");
  const now = Math.floor(Date.now() / 1000);
  const pasteLang = lang(params.get("lang"));
  const statements = [env.DB.prepare(
    "INSERT INTO pastes (id, lang, created_at, expires_at, burn, encrypted, size, creator_ip, country, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, pasteLang, now, seconds ? now + seconds : 0, burn, encrypted, data.length, meta.ip, meta.country, meta.client),
  env.DB.prepare(
    "INSERT INTO paste_stats (day, lang, client, pastes, bytes) VALUES (?, ?, ?, 1, ?) " +
    "ON CONFLICT(day, lang, client) DO UPDATE SET pastes = pastes + 1, bytes = bytes + excluded.bytes"
  ).bind(new Date(now * 1000).toISOString().slice(0, 10), pasteLang, meta.client, data.length)];
  // Separate rows preserve the Rust app's 8 MiB limit within D1's 2 MB row limit.
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
    statements.push(env.DB.prepare("INSERT INTO paste_chunks (paste_id, chunk_index, data) VALUES (?, ?, ?)")
      .bind(id, offset / CHUNK_BYTES, encode(data.subarray(offset, offset + CHUNK_BYTES))));
  }
  await env.DB.batch(statements);
  return {
    id, url: `${origin}/${id}`, raw_url: `${origin}/raw/${id}`, download_url: `${origin}/download/${id}`,
    lang: pasteLang, size: data.length, burn: Boolean(burn), encrypted: Boolean(encrypted),
    expires_at: seconds ? new Date((now + seconds) * 1000).toISOString() : null,
  };
}

function requestMeta(request, client) {
  return {
    ip: request.headers.get("CF-Connecting-IP"),
    country: typeof request.cf?.country === "string" ? request.cf.country : null,
    client,
  };
}

async function create(request, env, url) {
  const config = await settings.load(env);
  if (config.maintenance) throw new HttpError(503, config.maintenance_message);
  // Validate options before reading a body that would be rejected anyway.
  ttl(url.searchParams, config);
  flag(url.searchParams, "burn");
  flag(url.searchParams, "encrypted");
  const data = await readBody(request, config.max_bytes);
  // Browsers send a Mozilla/ User-Agent; curl, wget, and scripts do not.
  const client = /^Mozilla\//.test(request.headers.get("User-Agent") || "") ? "web" : "cli";
  const paste = await store(env, url.searchParams, data, url.origin, requestMeta(request, client));
  if (wantsJson(request)) return response(JSON.stringify(paste) + "\n", 200, "application/json");
  return response(paste.url);
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

// The editor's expiry choices within the maximum, including the default and its label.
function expiry(config) {
  const defaultTtl = config.default_ttl;
  const options = expiryOptions.filter(([, seconds]) => !config.max_ttl || (seconds > 0 && seconds <= config.max_ttl));
  if (!options.some(([, seconds]) => seconds === defaultTtl)) {
    options.push([`${defaultTtl} seconds`, defaultTtl]);
    options.sort((a, b) => (a[1] || Infinity) - (b[1] || Infinity));
  }
  return { options, label: options.find(([, seconds]) => seconds === defaultTtl)[0] };
}

async function page(env, values = {}, status = 200) {
  const config = await settings.load(env);
  const { options, label } = expiry(config);
  const data = {
    version: "0.2.0", uri_prefix: "", agent_links: true, ui_expiry_times: options,
    ui_expiry_default: label, max_size_label: settings.formatBytes(config.max_bytes),
    banner: config.banner, banner_level: config.banner_level,
    maintenance: config.maintenance ? config.maintenance_message : "",
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

function acceptsHtml(request) {
  return (request.headers.get("Accept") || "").includes("text/html");
}

function wantsJson(request) {
  return (request.headers.get("Accept") || "").includes("application/json");
}

async function limits(env) {
  const config = await settings.load(env);
  return { defaultExpiry: expiry(config).label, maxSize: settings.formatBytes(config.max_bytes), maxBytes: config.max_bytes };
}

// Serves a guide from static/ with this deployment's origin and limits filled in.
async function guide(asset, type, url, env) {
  const { defaultExpiry, maxSize } = await limits(env);
  const text = new TextDecoder().decode(decode(assets[asset])).replaceAll("__BASE__", url.origin)
    .replaceAll("__DEFAULT_EXPIRY__", defaultExpiry).replaceAll("__MAX_SIZE__", maxSize);
  return response(text, 200, type);
}

async function remove(id, env) {
  const result = await env.DB.prepare("DELETE FROM pastes WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

async function mcp(request, env, url) {
  const current = await limits(env);
  const context = {
    env, origin: url.origin, limits: current, api: { store, load, remove },
    meta: requestMeta(request, "agent"),
    // JSON escaping grows the content; store() still enforces the paste limit itself.
    readBody: () => readBody(request, current.maxBytes * 2 + MCP_ENVELOPE_BYTES),
  };
  return mcpResponse(request, context, response);
}

function missing(env) { return page(env, { is_error: true }, 404); }

async function route(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;
  const admin = await adminResponse(request, env, { loadPaste: load });
  if (admin) return admin;
  if (method === "POST" && path === "/") return create(request, env, url);
  if (path === "/mcp") return mcp(request, env, url);
  if (method === "DELETE" && /^\/[A-Za-z0-9_-]+$/.test(path)) {
    await remove(path.slice(1), env);
    return response(null);
  }
  if (method !== "GET" && method !== "HEAD") return response("Method not allowed.", 405, undefined, { Allow: "GET, HEAD, POST, DELETE" });
  // Browsers get the editor; curl, wget, and scripts get the plain-text guide.
  if (path === "/usage" || (path === "/" && !acceptsHtml(request))) return guide("/static/usage.txt", "text/plain; charset=utf-8", url, env);
  if (path === "/llms.txt") return guide("/static/llms.txt", "text/markdown; charset=utf-8", url, env);
  if (path === "/openapi.json") return response(JSON.stringify(openApi(url.origin, await limits(env)), null, 2), 200, "application/vnd.oai.openapi+json", { "Access-Control-Allow-Origin": "*" });
  if (path === "/.well-known/api-catalog") return response(JSON.stringify(apiCatalog(url.origin), null, 2), 200, 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"');
  if (path === "/robots.txt") return response(ROBOTS);
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
