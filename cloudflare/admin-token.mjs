// Admin sign-in with a shared secret token, for deployments without Cloudflare Access
// (Docker, Docker Compose, Helm). Browsers exchange the token for a signed session
// cookie; scripts may send it as `Authorization: Bearer <token>`.

export const TOKEN_IDENTITY = "admin token";
export const MIN_TOKEN_LENGTH = 32;
const COOKIE = "paste_admin";
const SESSION_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();

/** The configured token, or null when token sign-in is disabled or the token is too short. */
export function adminToken(env) {
  const token = typeof env.PASTE_ADMIN_TOKEN === "string" ? env.PASTE_ADMIN_TOKEN.trim() : "";
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Constant-time comparison of two strings via their SHA-256 digests. */
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Sessions are keyed by the token itself, so rotating the token signs everyone out.
async function sessionKey(token) {
  return crypto.subtle.importKey("raw", encoder.encode(`paste-admin-session:${token}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function signature(token, expires) {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(token), encoder.encode(`v1.${expires}`))));
}

function cookieValue(request) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return "";
}

/** Returns TOKEN_IDENTITY for a valid bearer token or session cookie, otherwise null. */
export async function tokenAdmin(request, env, now = Date.now()) {
  const token = adminToken(env);
  if (!token) return null;
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "")?.[1];
  if (bearer) return (await sameSecret(bearer.trim(), token)) ? TOKEN_IDENTITY : null;
  const match = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(cookieValue(request));
  if (!match || Number(match[1]) * 1000 <= now) return null;
  return (await sameSecret(match[2], await signature(token, match[1]))) ? TOKEN_IDENTITY : null;
}

export async function checkToken(candidate, env) {
  const token = adminToken(env);
  return Boolean(token && typeof candidate === "string" && (await sameSecret(candidate.trim(), token)));
}

export async function sessionCookie(env, url, now = Date.now()) {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const value = `v1.${expires}.${await signature(adminToken(env), expires)}`;
  return `${COOKIE}=${value}; Path=/admin; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`;
}

export function clearedCookie(url) {
  return `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`;
}
