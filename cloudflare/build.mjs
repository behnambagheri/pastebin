import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import Handlebars from "handlebars";
import { build } from "esbuild";
import { buildCss } from "./build-css.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
await buildCss();
await mkdir(path.join(root, "generated"), { recursive: true });
const template = await readFile(path.join(root, "../static/index.html"), "utf8");
// Translate the Rust Handlebars conditional into JavaScript Handlebars syntax.
const compatible = template.replace("{{#if is_created or is_clone}}", "{{#if (or is_created is_clone)}}");
await writeFile(path.join(root, "generated/template.mjs"), `export default ${Handlebars.precompile(compatible)};\n`);
const assets = {};
const assetVersions = {};
for (const filename of await readdir(path.join(root, "../static"))) {
  const contents = await readFile(path.join(root, "../static", filename));
  assets[`/static/${filename}`] = contents.toString("base64");
  assetVersions[`/static/${filename}`] = createHash("sha256").update(contents).digest("hex").slice(0, 12);
}
await writeFile(path.join(root, "generated/assets.mjs"), `export default ${JSON.stringify(assets)};\nexport const versions = ${JSON.stringify(assetVersions)};\n`);
const adminPage = (await readFile(path.join(root, "admin.html"), "utf8"))
  .replace("__STYLE_URL__", `/static/style.css?v=${assetVersions["/static/style.css"]}`);
const loginPage = (await readFile(path.join(root, "admin-login.html"), "utf8"))
  .replace("__STYLE_URL__", `/static/style.css?v=${assetVersions["/static/style.css"]}`);
await writeFile(path.join(root, "generated/admin-page.mjs"),
  `export default ${JSON.stringify(adminPage)};\nexport const loginPage = ${JSON.stringify(loginPage)};\n`);
const migrationFiles = (await readdir(path.join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
const migrations = await Promise.all(migrationFiles.map(async (name) => ({ name, sql: await readFile(path.join(root, "migrations", name), "utf8") })));
await writeFile(path.join(root, "generated/migrations.mjs"), `export default ${JSON.stringify(migrations)};\n`);
// The container server bundles the same Worker code with a SQLite-backed D1 adapter.
await build({
  entryPoints: [path.join(root, "server/index.mjs")],
  outfile: path.join(root, "dist/server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  minify: true,
});
await build({
  entryPoints: [path.join(root, "worker.mjs")],
  outfile: path.join(root, "dist/worker.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
console.log("Built the Worker and the container server with the daisyUI template and static assets.");
