import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { Miniflare } from "miniflare";

let mf, db;
before(async () => {
  mf = new Miniflare({
    scriptPath: new URL("../dist/worker.mjs", import.meta.url).pathname,
    modules: true, compatibilityDate: "2026-08-06",
    d1Databases: { DB: "test-pastes" }, bindings: { DEFAULT_TTL: "0" },
  });
  db = await mf.getD1Database("DB");
  const schema = await readFile(new URL("../migrations/0001_pastes.sql", import.meta.url), "utf8");
  for (const statement of schema.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
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

test("existing UI renders, static resources load, and errors use the UI", async () => {
  const root = await request("/", { redirect: "manual" });
  assert.equal(root.status, 303);
  assert.equal(root.headers.get("location"), "/new");
  const page = await request("/new");
  const html = await page.text();
  assert.match(html, /id="content-textarea"/);
  assert.match(html, /Expires: Never/);
  assert.ok(!html.includes("{{"));
  const js = await request("/static/custom.js");
  assert.equal(await js.text(), await readFile(new URL("../../static/custom.js", import.meta.url), "utf8"));
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
