import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { SignJWT, generateKeyPair, createLocalJWKSet, exportJWK } from "jose";
import { migrate } from "./helpers.mjs";
import { adminResponse } from "../admin.mjs";
import { authorizedAdmin } from "../admin-auth.mjs";

const ORIGIN = "https://paste.example";
let mf, env;
before(async () => {
  mf = new Miniflare({ modules: true, script: "export default {}", compatibilityDate: "2026-08-06", d1Databases: { DB: "admin-test" } });
  env = { DB: await mf.getD1Database("DB"), DEFAULT_TTL: "2592000" };
  await migrate(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const rows = [
    ["aaaaone", "bash", now - 30, 0, 0, 0, 12, "203.0.113.7", "SE", "cli"],
    ["aaaatwo", "python", now - 20, now + 3600, 1, 0, 34, "203.0.113.7", "SE", "web"],
    ["bbbbone", "json", now - 10, 0, 0, 1, 56, "198.51.100.9", "DE", "cli"],
    ["expired", "bash", now - 99, now - 1, 0, 0, 1, "198.51.100.9", null, "cli"],
  ];
  for (const row of rows) {
    await env.DB.prepare("INSERT INTO pastes (id, lang, created_at, expires_at, burn, encrypted, size, creator_ip, country, client) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(...row).run();
    await env.DB.prepare("INSERT INTO paste_chunks (paste_id, chunk_index, data) VALUES (?, 0, ?)").bind(row[0], btoa(`content of ${row[0]}`)).run();
  }
  await env.DB.prepare("INSERT INTO paste_stats VALUES (?, 'bash', 'cli', 3, 100), (?, 'python', 'web', 1, 34)")
    .bind(new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10)).run();
});
after(async () => { await mf?.dispose(); });

const loadPaste = async (id, db, consume) => {
  assert.equal(consume, false, "admin previews must not consume pastes");
  const paste = await db.DB.prepare("SELECT * FROM pastes WHERE id = ?").bind(id).first();
  if (!paste) return null;
  const chunk = await db.DB.prepare("SELECT data FROM paste_chunks WHERE paste_id = ?").bind(id).first();
  return { ...paste, bytes: Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)) };
};
function call(path, { method = "GET", json, origin = ORIGIN, authorize = async () => "admin@example.com" } = {}) {
  const headers = { Origin: origin };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(ORIGIN + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return adminResponse(request, env, { authorize, loadPaste });
}

test("non-admin paths are ignored and unauthorized requests are refused", async () => {
  assert.equal(await call("/new"), null);
  assert.equal(await call("/administrator"), null);
  const refused = await call("/admin/api/pastes", { authorize: async () => null });
  assert.equal(refused.status, 403);
});

test("the admin page is private and does not allow framing", async () => {
  const page = await call("/admin");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /href="\/static\/ds\/v1\/tokens\.css\?v=[0-9a-f]{12}"/);
  assert.match(html, /href="\/static\/style\.css\?v=[0-9a-f]{12}"/);
  assert.match(page.headers.get("content-security-policy"), /font-src 'self'/);
});

test("paste list hides expired pastes and searches by ID prefix or creator IP", async () => {
  const all = await (await call("/admin/api/pastes")).json();
  assert.deepEqual(all.pastes.map((p) => p.id), ["bbbbone", "aaaatwo", "aaaaone"]);
  assert.equal(all.total, 3);
  assert.equal(all.pastes[1].creator_ip, "203.0.113.7");
  const byPrefix = await (await call("/admin/api/pastes?q=aaaa")).json();
  assert.equal(byPrefix.total, 2);
  const byIp = await (await call("/admin/api/pastes?q=198.51.100.9")).json();
  assert.deepEqual(byIp.pastes.map((p) => p.id), ["bbbbone"]);
  const wildcard = await (await call("/admin/api/pastes?q=%25")).json();
  assert.equal(wildcard.total, 0, "LIKE wildcards are escaped");
});

test("preview reads a burn paste without consuming it", async () => {
  const raw = await call("/admin/api/pastes/aaaatwo/raw");
  assert.equal(await raw.text(), "content of aaaatwo");
  assert.ok(await env.DB.prepare("SELECT 1 FROM pastes WHERE id = 'aaaatwo'").first());
});

test("statistics summarize active pastes and daily counters", async () => {
  const stats = await (await call("/admin/api/stats?days=7")).json();
  assert.equal(stats.series.length, 7);
  assert.equal(stats.series.at(-1).pastes, 4);
  assert.deepEqual(stats.active, { pastes: 3, bytes: 102, creators: 2 });
  assert.equal(stats.clients.cli, 3);
  assert.equal(stats.languages[0].lang, "bash");
});

test("settings validate, save with the admin's email, and refuse cross-site writes", async () => {
  const initial = await (await call("/admin/api/settings")).json();
  assert.equal(initial.settings.default_ttl, 2592000);
  assert.equal(initial.updated, null);
  const invalid = await call("/admin/api/settings", { method: "PUT", json: { max_ttl: 3600 } });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /within the maximum/);
  const crossSite = await call("/admin/api/settings", { method: "PUT", json: { banner: "x" }, origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  const saved = await call("/admin/api/settings", { method: "PUT", json: { banner: "  Hello  ", maintenance: true, maintenance_message: "Paused" } });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.settings.banner, "Hello");
  assert.equal(body.updated.updated_by, "admin@example.com");
});

test("deleting one paste and all pastes from an IP", async () => {
  assert.equal((await call("/admin/api/pastes/bbbbone", { method: "DELETE" })).status, 200);
  assert.equal((await call("/admin/api/pastes/bbbbone", { method: "DELETE" })).status, 404);
  const result = await (await call("/admin/api/pastes/delete-by-ip", { method: "POST", json: { ip: "203.0.113.7" } })).json();
  assert.equal(result.deleted, 2);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM paste_chunks WHERE paste_id LIKE 'aaaa%'").first()).n, 0);
  assert.equal((await call("/admin/api/pastes/delete-by-ip", { method: "POST", json: { ip: "not an ip" } })).status, 400);
});

test("Cloudflare Access tokens must be signed, unexpired, for this app, and for an allowed email", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keySet = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "k1" }] });
  const issuer = "https://team.cloudflareaccess.com";
  const authEnv = { PASTE_ACCESS_ISSUER: issuer, PASTE_ACCESS_AUD: "app-aud", PASTE_ADMIN_EMAILS: "Admin@Example.com, other@example.com" };
  const sign = (claims, { audience = "app-aud", expires = "5m" } = {}) => new SignJWT({ email: "admin@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(issuer).setAudience(audience).setSubject("user-1")
    .setIssuedAt().setExpirationTime(expires).sign(privateKey);
  const check = async (token, environment = authEnv) => authorizedAdmin(
    new Request(ORIGIN + "/admin", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} }), environment, { keySet });

  assert.equal(await check(await sign({})), "admin@example.com");
  assert.equal(await check(await sign({ email: "intruder@example.com" })), null);
  assert.equal(await check(await sign({}, { audience: "other-app" })), null);
  assert.equal(await check(await sign({}, { expires: Math.floor(Date.now() / 1000) - 60 })), null);
  assert.equal(await check(null), null);
  assert.equal(await check(await sign({}), { ...authEnv, PASTE_ADMIN_EMAILS: "" }), null);
  assert.equal(await check(await sign({}), { ...authEnv, PASTE_ACCESS_ISSUER: "https://evil.example" }), null);
});
