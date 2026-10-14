import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPasteServer, serverConfig } from "../server/index.mjs";
import { SqliteD1, migrate } from "../server/sqlite-d1.mjs";
import migrations from "../generated/migrations.mjs";
import { tokenAdmin, sessionCookie } from "../admin-token.mjs";

const TOKEN = "a".repeat(20) + "-container-admin-token-for-tests";
const directory = mkdtempSync(join(tmpdir(), "paste-server-"));
let database;

async function serve(env) {
  const config = serverConfig({ PASTE_DATA_DIR: directory, PASTE_ADMIN_TOKEN: TOKEN, PASTE_DEFAULT_TTL: "0", ...env });
  const server = createPasteServer(config, database);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

before(() => {
  database = new SqliteD1(join(directory, "paste.sqlite3"));
  assert.deepEqual(migrate(database, migrations), ["0001_pastes.sql", "0002_admin.sql"]);
});
after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

test("migrations are recorded and not applied twice", () => {
  assert.deepEqual(migrate(database, migrations), []);
  const names = database.sqlite.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((row) => row.name);
  assert.deepEqual(names, ["0001_pastes.sql", "0002_admin.sql"]);
});

test("pastes round trip through the container server with health checks", async () => {
  const { base, close } = await serve();
  try {
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: "ok", revision: "development" });
    const link = await (await fetch(`${base}/?lang=bash`, { method: "POST", body: "echo container" })).text();
    assert.match(link, new RegExp(`^${base}/[A-Za-z0-9_-]{21}$`));
    const id = link.split("/").pop();
    assert.equal(await (await fetch(`${base}/raw/${id}`)).text(), "echo container");
    assert.match(await (await fetch(`${base}/${id}`)).text(), /language-bash/);
    const guide = await (await fetch(`${base}/`)).text();
    assert.match(guide, /^Paste - Usage/);
    const burn = (await (await fetch(`${base}/?burn=true`, { method: "POST", body: "once" })).text()).split("/").pop();
    const reads = await Promise.all([1, 2, 3].map(() => fetch(`${base}/raw/${burn}`)));
    assert.deepEqual(reads.map((r) => r.status).sort(), [200, 404, 404]);
    const tooLarge = await fetch(`${base}/`, { method: "POST", body: new Uint8Array(8 * 1024 * 1024 + 1) });
    assert.equal(tooLarge.status, 413);
  } finally { await close(); }
});

test("client IPs come from the socket unless a header is explicitly trusted", async () => {
  const spoof = { "X-Forwarded-For": "198.51.100.1", "CF-Connecting-IP": "198.51.100.2" };
  const untrusted = await serve();
  try {
    const id = (await (await fetch(`${untrusted.base}/`, { method: "POST", body: "x", headers: spoof })).text()).split("/").pop();
    assert.equal((await database.prepare("SELECT creator_ip FROM pastes WHERE id = ?").bind(id).first()).creator_ip, "127.0.0.1");
  } finally { await untrusted.close(); }
  const trusted = await serve({ PASTE_TRUSTED_HEADERS: "X-Forwarded-For", PASTE_PUBLIC_URL: "https://paste.example.com" });
  try {
    const link = await (await fetch(`${trusted.base}/`, { method: "POST", body: "x", headers: spoof })).text();
    assert.match(link, /^https:\/\/paste\.example\.com\//);
    const row = await database.prepare("SELECT creator_ip FROM pastes WHERE id = ?").bind(link.split("/").pop()).first();
    assert.equal(row.creator_ip, "198.51.100.1");
  } finally { await trusted.close(); }
});

test("the admin token signs in through the login page or as a bearer token", async () => {
  const { base, close } = await serve();
  const origin = { Origin: base };
  try {
    const signedOut = await fetch(`${base}/admin`, { redirect: "manual" });
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.headers.get("location"), "/admin/login");
    assert.equal((await fetch(`${base}/admin/api/pastes`)).status, 403);
    assert.match(await (await fetch(`${base}/admin/login`)).text(), /name="token"/);

    const form = (token) => new URLSearchParams({ token });
    const wrong = await fetch(`${base}/admin/login`, { method: "POST", body: form("not-the-token"), headers: origin });
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /That token is not valid/);
    const crossSite = await fetch(`${base}/admin/login`, { method: "POST", body: form(TOKEN), headers: { Origin: "https://evil.example" }, redirect: "manual" });
    assert.equal(crossSite.status, 403);

    const login = await fetch(`${base}/admin/login`, { method: "POST", body: form(TOKEN), headers: origin, redirect: "manual" });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.deepEqual(await (await fetch(`${base}/admin/api/session`, { headers: { Cookie: cookie } })).json(), { email: "admin token", method: "token" });
    assert.equal((await fetch(`${base}/admin`, { headers: { Cookie: cookie } })).status, 200);
    const forged = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    assert.equal((await fetch(`${base}/admin/api/pastes`, { headers: { Cookie: forged } })).status, 403);

    const bearer = await fetch(`${base}/admin/api/stats`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(bearer.status, 200);
    assert.equal((await fetch(`${base}/admin/api/stats`, { headers: { Authorization: "Bearer wrong" } })).status, 403);

    const logout = await fetch(`${base}/admin/logout`, { method: "POST", headers: { ...origin, Cookie: cookie }, redirect: "manual" });
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  } finally { await close(); }
});

test("sessions expire and stop working when the token changes", async () => {
  const env = { PASTE_ADMIN_TOKEN: TOKEN };
  const url = new URL("http://paste.example/admin");
  const cookie = (await sessionCookie(env, url, Date.now())).split(";")[0];
  const request = new Request(url, { headers: { Cookie: cookie } });
  assert.equal(await tokenAdmin(request, env), "admin token");
  assert.equal(await tokenAdmin(request, env, Date.now() + 13 * 60 * 60 * 1000), null);
  assert.equal(await tokenAdmin(request, { PASTE_ADMIN_TOKEN: TOKEN + "-rotated" }), null);
  assert.equal(await tokenAdmin(request, {}), null);
});

test("configuration rejects short tokens and reads token files", () => {
  assert.throws(() => serverConfig({ PASTE_ADMIN_TOKEN: "short" }), /at least 32 characters/);
  const file = join(directory, "token");
  writeFileSync(file, `${TOKEN}\n`);
  assert.equal(serverConfig({ PASTE_ADMIN_TOKEN_FILE: file }).workerEnv.PASTE_ADMIN_TOKEN, TOKEN);
  assert.throws(() => serverConfig({ PASTE_PUBLIC_URL: "https://paste.example.com/sub" }), /without a path/);
  assert.deepEqual(serverConfig({ PASTE_LISTEN: "[::]:9000" }).host, "::");
});
