import { readFile, readdir } from "node:fs/promises";

/** Applies every migration in order, like `wrangler d1 migrations apply`. */
export async function migrate(db) {
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = (await readFile(new URL(file, directory), "utf8")).replace(/^\s*--.*$/gm, "");
    for (const statement of sql.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
  }
}
