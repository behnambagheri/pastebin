import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const root = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(root, "style.css");
const output = path.join(root, "../static/style.css");

// Compiles the Tailwind/daisyUI source into static/style.css. The output is committed
// because the Rust server embeds static/ at compile time without a Node.js toolchain.
export async function buildCss() {
  const result = await postcss([tailwindcss({ optimize: true })]).process(await readFile(source, "utf8"), { from: source });
  await writeFile(output, result.css);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildCss();
