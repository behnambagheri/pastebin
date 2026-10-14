import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { Miniflare } from "miniflare";
import { migrate } from "./helpers.mjs";

let mf, db;
before(async () => {
  mf = new Miniflare({
    scriptPath: new URL("../dist/worker.mjs", import.meta.url).pathname,
    modules: true, compatibilityDate: "2026-08-06",
    d1Databases: { DB: "test-pastes" }, bindings: { DEFAULT_TTL: "0" },
  });
  db = await mf.getD1Database("DB");
  await migrate(db);
});
after(async () => { await mf?.dispose(); });

const request = (path, options) => mf.dispatchFetch(`https://paste.example${path}`, options);
async function create(body, query = "") {
  const result = await request(`/${query}`, { method: "POST", body });
  assert.equal(result.status, 200);
  const url = new URL(await result.text());
  assert.equal(url.origin, "https://paste.example");
  assert.match(url.pathname, /^\/[A-Za-z0-9_-]{21}$/);
  return url.pathname.slice(1);
}

test("daisyUI page renders, static resources load, and errors use the UI", async () => {
  const root = await request("/", { redirect: "manual", headers: { Accept: "text/html,*/*" } });
  assert.equal(root.status, 303);
  assert.equal(root.headers.get("location"), "/new");
  const page = await request("/new");
  const html = await page.text();
  assert.match(html, /id="content-textarea"/);
  assert.match(html, /id="expiry-selector"[^>]*data-default="Never"/);
  assert.match(html, /href="\/static\/style.css\?v=[0-9a-f]{12}"/);
  assert.match(html, /src="\/static\/custom.js\?v=[0-9a-f]{12}"/);
  assert.ok(!/cdnjs|jquery|bootstrap/i.test(html));
  assert.ok(!html.includes("{{"));
  const js = await request("/static/custom.js");
  assert.equal(await js.text(), await readFile(new URL("../../static/custom.js", import.meta.url), "utf8"));
  assert.match(html, /id="usage-dialog"/);
  const guide = await request("/usage");
  assert.equal(guide.headers.get("content-type"), "text/plain; charset=utf-8");
  const text = await guide.text();
  assert.match(text, /^Paste - Usage/);
  assert.ok(!/__[A-Z_]+__/.test(text));
  assert.match(text, /Default when ttl is omitted: Never\./);
  const cli = await request("/", { redirect: "manual", headers: { Accept: "*/*" } });
  assert.equal(cli.status, 200);
  assert.equal(await cli.text(), text);
  const missing = await request("/missing");
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /The page you are looking for was not found/);
});

test("text, binary, download, clone, safe highlighting, and deletion", async () => {
  const content = '<script>alert("test")</script>\nUnicode: فارسی 🎉';
  const id = await create(content, '?lang=javascript');
  const view = await request(`/${id}?lang=${encodeURIComponent('"><script>')}`);
  const html = await view.text();
  assert.match(html, /language-markup/);
  assert.ok(!html.includes('<script>alert("test")</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.equal(view.headers.get("cache-control"), "no-store");
  assert.equal(await (await request(`/raw/${id}`)).text(), content);
  assert.match(await (await request(`/new?id=${id}`)).text(), /id="content-textarea"/);
  assert.equal((await request(`/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await request(`/raw/${id}`)).status, 404);
  const bytes = new Uint8Array([0, 1, 128, 255, 10]);
  const binaryId = await create(bytes);
  const downloaded = await request(`/download/${binaryId}`);
  assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);
});

test("burn pastes have exactly one successful concurrent reader and HEAD does not consume", async () => {
  const id = await create("read once", "?burn=true");
  assert.equal((await request(`/raw/${id}`, { method: "HEAD" })).status, 200);
  const results = await Promise.all(Array.from({ length: 8 }, () => request(`/raw/${id}`)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 404).length, 7);
  assert.equal(await results.find((r) => r.status === 200).text(), "read once");
  assert.equal((await db.prepare("SELECT count(*) AS n FROM paste_chunks WHERE paste_id = ?").bind(id).first()).n, 0);
});

test("expired pastes are inaccessible and their chunks are deleted", async () => {
  const id = await create("expires", "?ttl=60");
  await db.prepare("UPDATE pastes SET expires_at = 1 WHERE id = ?").bind(id).run();
  assert.equal((await request(`/raw/${id}`)).status, 404);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM paste_chunks WHERE paste_id = ?").bind(id).first()).n, 0);
  for (const query of ["?ttl=-1", "?ttl=abc", "?burn=maybe", "?encrypted=invalid"]) {
    assert.equal((await request(`/${query}`, { method: "POST", body: "test" })).status, 422);
  }
  assert.equal((await request("/new?url=javascript:alert(1)")).status, 200);
  assert.ok(!(await (await request("/new?url=javascript:alert(1)")).text()).includes('href="javascript:'));
});

test("the complete 8 MiB limit round trips across D1 rows; larger bodies are rejected", async () => {
  const body = new Uint8Array(8 * 1024 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const id = await create(body);
  assert.deepEqual(new Uint8Array(await (await request(`/raw/${id}`)).arrayBuffer()), body);
  assert.equal((await request("/", { method: "POST", body: new Uint8Array(body.length + 1) })).status, 413);
  await request(`/${id}`, { method: "DELETE" });
});

test("scheduled cleanup removes expired pastes without waiting for a reader", async () => {
  const id = await create("scheduled cleanup fixture", "?ttl=60");
  await db.prepare("UPDATE pastes SET expires_at = 1 WHERE id = ?").bind(id).run();
  const worker = (await import("../dist/worker.mjs")).default;
  const pending = [];
  await worker.scheduled({}, { DB: db }, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM pastes WHERE id = ?").bind(id).first()).n, 0);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM paste_chunks WHERE paste_id = ?").bind(id).first()).n, 0);
});

test("existing browser encryption remains compatible with storage and rendering", async () => {
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob,
    document: {}, $: () => ({ ready() {} }),
  });
  vm.runInContext(await readFile(new URL("../../static/custom.js", import.meta.url), "utf8"), context);
  const encrypted = await context.cryptoEncrypt("private fixture", "test password");
  const id = await create(encrypted, "?encrypted=true");
  const raw = await (await request(`/raw/${id}`)).text();
  assert.equal(await context.cryptoDecrypt(raw, "test password"), "private fixture");
  await assert.rejects(context.cryptoDecrypt(raw, "wrong password"));
  assert.match(await (await request(`/${id}`)).text(), /id="password-modal"/);
});

test("creation records size, creator IP, client, and daily statistics", async () => {
  const cli = await request("/?lang=bash", { method: "POST", body: "hello", headers: { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "curl/8.7.1" } });
  const cliId = new URL(await cli.text()).pathname.slice(1);
  const web = await request("/", { method: "POST", body: "from the editor", headers: { "CF-Connecting-IP": "2001:db8::1", "User-Agent": "Mozilla/5.0 Safari" } });
  const webId = new URL(await web.text()).pathname.slice(1);
  const row = await db.prepare("SELECT size, creator_ip, client, lang FROM pastes WHERE id = ?").bind(cliId).first();
  assert.deepEqual(row, { size: 5, creator_ip: "203.0.113.7", client: "cli", lang: "bash" });
  assert.equal((await db.prepare("SELECT client FROM pastes WHERE id = ?").bind(webId).first()).client, "web");
  const today = new Date().toISOString().slice(0, 10);
  const stats = await db.prepare("SELECT SUM(pastes) AS n FROM paste_stats WHERE day = ? AND lang = 'bash' AND client = 'cli'").bind(today).first();
  assert.ok(stats.n >= 1);
});

test("admin routes are closed without Cloudflare Access configuration and a valid token", async () => {
  for (const path of ["/admin", "/admin/", "/admin/api/pastes", "/admin/api/settings"]) {
    const result = await request(path, { headers: { "Cf-Access-Jwt-Assertion": "forged.token.value" } });
    assert.equal(result.status, 403, path);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
  }
  assert.equal((await request("/admin/api/settings", { method: "PUT", body: "{}" })).status, 403);
});

async function withSettings(value, run) {
  // A fresh isolate avoids the per-isolate settings cache.
  const isolated = new Miniflare({
    scriptPath: new URL("../dist/worker.mjs", import.meta.url).pathname,
    modules: true, compatibilityDate: "2026-08-06",
    d1Databases: { DB: "settings-test" }, bindings: { DEFAULT_TTL: "0" },
  });
  try {
    const store = await isolated.getD1Database("DB");
    await migrate(store);
    await store.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, 0)").bind(JSON.stringify(value)).run();
    await run((path, options) => isolated.dispatchFetch(`https://paste.example${path}`, options));
  } finally {
    await isolated.dispose();
  }
}

test("maintenance mode and the banner come from saved settings", async () => {
  await withSettings({ maintenance: true, maintenance_message: "Back at noon.", banner: "Scheduled upgrade today.", banner_level: "warning" }, async (fetchPath) => {
    const blocked = await fetchPath("/", { method: "POST", body: "x" });
    assert.equal(blocked.status, 503);
    assert.equal(await blocked.text(), "Back at noon.");
    const html = await (await fetchPath("/new")).text();
    assert.match(html, /Back at noon\./);
    assert.match(html, /alert-warning">[\s\S]*Scheduled upgrade today\./);
    assert.match(html, /id="send-btn"[^>]* disabled/);
  });
});

test("expiry and size limits come from saved settings", async () => {
  await withSettings({ default_ttl: 3600, max_ttl: 86400, max_bytes: 2048 }, async (fetchPath) => {
    assert.equal((await fetchPath("/?ttl=0", { method: "POST", body: "x" })).status, 422);
    assert.equal((await fetchPath("/?ttl=604800", { method: "POST", body: "x" })).status, 422);
    assert.equal((await fetchPath("/?ttl=600", { method: "POST", body: "x" })).status, 200);
    const tooBig = await fetchPath("/", { method: "POST", body: "x".repeat(2049) });
    assert.equal(tooBig.status, 413);
    assert.equal(await tooBig.text(), "Maximum paste size is 2 KiB.");
    const html = await (await fetchPath("/new")).text();
    assert.match(html, /data-default="1 hour"/);
    assert.ok(!html.includes('value="0">Never'));
    assert.ok(!html.includes('value="604800"'));
    const guide = await (await fetchPath("/usage")).text();
    assert.match(guide, /Default when ttl is omitted: 1 hour\./);
    assert.match(guide, /limited to 2 KiB\./);
  });
});

test("agents can discover the API through llms.txt, OpenAPI, the API catalog, and Link headers", async () => {
  const llms = await request("/llms.txt");
  assert.equal(llms.headers.get("content-type"), "text/markdown; charset=utf-8");
  const text = await llms.text();
  assert.match(text, /^# Paste\n/);
  assert.match(text, /https:\/\/paste\.example\/mcp/);
  assert.ok(!/__[A-Z_]+__/.test(text));
  const spec = await (await request("/openapi.json")).json();
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.servers[0].url, "https://paste.example");
  assert.equal(spec.paths["/"].post.operationId, "createPaste");
  const catalog = await request("/.well-known/api-catalog");
  assert.match(catalog.headers.get("content-type"), /^application\/linkset\+json/);
  assert.equal((await catalog.json()).linkset[0]["service-desc"][0].href, "https://paste.example/openapi.json");
  const page = await request("/new");
  assert.match(page.headers.get("link"), /<\/llms\.txt>; rel="describedby"/);
  assert.match(await page.text(), /<link rel="service-desc"[^>]*href="\/openapi\.json"/);
  const robots = await (await request("/robots.txt")).text();
  assert.match(robots, /Allow: \/llms\.txt/);
  assert.match(robots, /Disallow: \/\n/);
  assert.match(await (await request("/usage")).text(), /claude mcp add --transport http paste https:\/\/paste\.example\/mcp/);
});

test("POST / returns JSON when asked", async () => {
  const result = await request("/?ttl=600&lang=json", { method: "POST", body: "{}", headers: { Accept: "application/json" } });
  assert.equal(result.headers.get("content-type"), "application/json");
  const paste = await result.json();
  assert.equal(paste.url, `https://paste.example/${paste.id}`);
  assert.equal(paste.raw_url, `https://paste.example/raw/${paste.id}`);
  assert.equal(paste.lang, "json");
  assert.equal(paste.size, 2);
  assert.ok(Math.abs(Date.parse(paste.expires_at) - Date.now() - 600_000) < 60_000);
  assert.equal(await (await request(`/raw/${paste.id}`)).text(), "{}");
});

const rpc = (body, headers = {}) => request("/mcp", {
  method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
});

test("the MCP server initializes, lists tools, and creates, reads, and deletes pastes", async () => {
  const init = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })).json();
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["create_paste", "read_paste", "delete_paste"]);

  const call = async (name, args) => (await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })).json()).result;
  const created = await call("create_paste", { content: "from an agent: فارسی", lang: "markdown", ttl: 600 });
  const paste = created.structuredContent;
  assert.equal(paste.lang, "markdown");
  assert.deepEqual(JSON.parse(created.content[0].text), paste);
  const row = await db.prepare("SELECT client FROM pastes WHERE id = ?").bind(paste.id).first();
  assert.equal(row.client, "agent");
  assert.equal((await call("read_paste", { id: paste.url })).content[0].text, "from an agent: فارسی");
  assert.equal((await call("read_paste", { id: paste.raw_url })).content[0].text, "from an agent: فارسی");
  assert.equal((await call("delete_paste", { id: paste.id })).content[0].text, `Deleted paste ${paste.id}.`);
  assert.equal((await call("read_paste", { id: paste.id })).isError, true);

  const burned = (await call("create_paste", { content: "once", burn: true })).structuredContent;
  assert.match((await call("read_paste", { id: burned.id })).content[1].text, /burn-after-reading/);
  assert.equal((await request(`/raw/${burned.id}`)).status, 404);

  assert.equal((await call("create_paste", { content: "x", ttl: -5 })).isError, true);
  assert.equal((await call("read_paste", { id: "../etc" })).isError, true);
});

test("the MCP endpoint reports protocol errors", async () => {
  assert.equal((await request("/mcp")).status, 405);
  const bad = await request("/mcp", { method: "POST", body: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  assert.equal((await (await rpc({ jsonrpc: "2.0", id: 9, method: "resources/list" })).json()).error.code, -32601);
  assert.equal((await (await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope" } })).json()).error.code, -32602);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 9, method: "ping" }, { "MCP-Protocol-Version": "1999-01-01" })).status, 400);
  const unknown = await (await rpc({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2099-01-01" } })).json();
  assert.equal(unknown.result.protocolVersion, "2025-11-25");
});
