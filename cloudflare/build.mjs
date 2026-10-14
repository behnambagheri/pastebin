import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
for (const filename of await readdir(path.join(root, "../static"))) {
  const contents = await readFile(path.join(root, "../static", filename));
  assets[`/static/${filename}`] = contents.toString("base64");
}
await writeFile(path.join(root, "generated/assets.mjs"), `export default ${JSON.stringify(assets)};\n`);
await build({
  entryPoints: [path.join(root, "worker.mjs")],
  outfile: path.join(root, "dist/worker.mjs"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});
console.log("Built Worker with the daisyUI template and static assets.");
