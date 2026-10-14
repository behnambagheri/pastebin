import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const base = process.argv[2] || "https://bea-paste.bagheri.workers.dev";
const ids = new Set();
const request = (path, options) => fetch(new URL(path, base), { signal: AbortSignal.timeout(30000), ...options });
async function create(body, query = "") {
  const result = await request(`/${query}`, { method: "POST", body });
  assert.equal(result.status, 200, `Create failed: ${await result.clone().text()}`);
  const id = new URL(await result.text()).pathname.slice(1);
  ids.add(id);
  return id;
}
try {
  const page = await request("/new");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="content-textarea"/);
  const marker = `Cloudflare deployment verification ${randomUUID()}\nUnicode: فارسی`;
  const id = await create(marker, "?ttl=300&lang=javascript");
  assert.equal(await (await request(`/raw/${id}`)).text(), marker);
  const view = await request(`/${id}`);
  assert.equal(view.status, 200);
  assert.equal(view.headers.get("cache-control"), "no-store");
  assert.match(await view.text(), /language-javascript/);
  assert.match(await (await request(`/new?id=${id}`)).text(), /Cloudflare deployment verification/);
  await request(`/${id}`, { method: "DELETE" });
  assert.equal((await request(`/raw/${id}`)).status, 404);
  console.log("Passed: create, view, raw, clone, and delete.");

  const burnId = await create("one-time verification fixture", "?burn=true&ttl=300");
  assert.equal((await request(`/raw/${burnId}`, { method: "HEAD" })).status, 200);
  const readers = await Promise.all(Array.from({ length: 8 }, () => request(`/raw/${burnId}`)));
  assert.equal(readers.filter((r) => r.status === 200).length, 1);
  assert.equal(readers.filter((r) => r.status === 404).length, 7);
  console.log("Passed: exactly one concurrent burn reader; HEAD preserves the paste.");

  const expiring = await create("expiry verification fixture", "?ttl=1");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await request(`/raw/${expiring}`)).status, 404);
  console.log("Passed: expiry enforcement.");

  const bytes = new Uint8Array(8 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const largeId = await create(bytes, "?ttl=300");
  const downloaded = await request(`/download/${largeId}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);
  console.log("Passed: complete 8 MiB binary round trip.");

  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob, document: {}, $: () => ({ ready() {} }) });
  vm.runInContext(await readFile(new URL("../../static/custom.js", import.meta.url), "utf8"), context);
  const encrypted = await context.cryptoEncrypt("encrypted verification fixture", "fixture password");
  const encryptedId = await create(encrypted, "?encrypted=true&ttl=300");
  const ciphertext = await (await request(`/raw/${encryptedId}`)).text();
  assert.equal(await context.cryptoDecrypt(ciphertext, "fixture password"), "encrypted verification fixture");
  assert.match(await (await request(`/${encryptedId}`)).text(), /id="password-modal"/);
  console.log("Passed: existing client encryption, storage, and password UI.");
} finally {
  for (const id of ids) {
    const result = await request(`/${id}`, { method: "DELETE" });
    assert.equal(result.status, 200, "Fixture cleanup failed.");
  }
  console.log("Removed verification fixtures.");
}
