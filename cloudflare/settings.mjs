// Admin-editable runtime settings, stored in D1 so changes apply without a deploy.

export const HARD_MAX_BYTES = 8 * 1024 * 1024;
const CACHE_MS = 10_000;
const LEVELS = ["info", "success", "warning", "error"];
let cached = null;

/** A user-facing validation failure; its message is safe to show. */
export class InputError extends Error {}

export function defaults(env) {
  const defaultTtl = Number(env.DEFAULT_TTL || 0);
  return {
    default_ttl: Number.isSafeInteger(defaultTtl) && defaultTtl >= 0 ? defaultTtl : 0,
    max_ttl: 0,
    max_bytes: HARD_MAX_BYTES,
    maintenance: false,
    maintenance_message: "New pastes are temporarily disabled for maintenance.",
    banner: "",
    banner_level: "info",
  };
}

function seconds(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 100 * 365 * 86400) {
    throw new InputError(`${name} must be a whole number of seconds.`);
  }
  return number;
}

function text(value, name, limit) {
  if (typeof value !== "string") throw new InputError(`${name} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new InputError(`${name} must be at most ${limit} characters.`);
  return trimmed;
}

/** Validates a full or partial settings object on top of `base`; throws InputError with a readable message. */
export function validate(input, base) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Settings must be a JSON object.");
  const next = { ...base };
  if ("default_ttl" in input) next.default_ttl = seconds(input.default_ttl, "Default expiry");
  if ("max_ttl" in input) next.max_ttl = seconds(input.max_ttl, "Maximum expiry");
  if ("max_bytes" in input) {
    const bytes = Number(input.max_bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > HARD_MAX_BYTES) {
      throw new InputError("Maximum paste size must be between 1 KiB and 8 MiB.");
    }
    next.max_bytes = bytes;
  }
  if ("maintenance" in input) {
    if (typeof input.maintenance !== "boolean") throw new InputError("Maintenance must be true or false.");
    next.maintenance = input.maintenance;
  }
  if ("maintenance_message" in input) next.maintenance_message = text(input.maintenance_message, "Maintenance message", 300);
  if ("banner" in input) next.banner = text(input.banner, "Banner", 300);
  if ("banner_level" in input) {
    if (!LEVELS.includes(input.banner_level)) throw new InputError(`Banner style must be one of: ${LEVELS.join(", ")}.`);
    next.banner_level = input.banner_level;
  }
  if (next.max_ttl > 0 && (next.default_ttl === 0 || next.default_ttl > next.max_ttl)) {
    throw new InputError("Default expiry must be within the maximum expiry.");
  }
  if (next.maintenance && !next.maintenance_message) throw new InputError("Maintenance mode needs a message.");
  return next;
}

export async function load(env, { fresh = false } = {}) {
  if (!fresh && cached && cached.expires > Date.now()) return cached.value;
  const base = defaults(env);
  let value = base;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site'").first();
  if (row) {
    try { value = validate(JSON.parse(row.value), base); }
    catch { console.error("Stored settings are invalid; using defaults."); }
  }
  cached = { value, expires: Date.now() + CACHE_MS };
  return value;
}

export async function save(env, input, email) {
  const value = validate(input, await load(env, { fresh: true }));
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('site', ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
  ).bind(JSON.stringify(value), Math.floor(Date.now() / 1000), email).run();
  cached = { value, expires: Date.now() + CACHE_MS };
  return value;
}

export async function metadata(env) {
  return env.DB.prepare("SELECT updated_at, updated_by FROM settings WHERE key = 'site'").first();
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}
