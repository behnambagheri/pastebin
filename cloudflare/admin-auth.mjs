import { createRemoteJWKSet, jwtVerify } from "jose";

// Same scheme as ip.bea.sh: Cloudflare Access signs in the user, and the Worker
// verifies the Access JWT and an administrator email allowlist on every request.
const keySets = new Map();

/** Returns the administrator's email, or null. Missing config, forged headers, and bad tokens fail closed. */
export async function authorizedAdmin(request, env, { keySet, now = new Date() } = {}) {
  const issuer = env.PASTE_ACCESS_ISSUER;
  const audience = env.PASTE_ACCESS_AUD;
  const emails = (env.PASTE_ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || "") || !audience || !emails.length) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 16384) return null;
  try {
    if (!keySet) {
      if (!keySets.has(issuer)) {
        if (keySets.size >= 4) keySets.clear();
        keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 }));
      }
      keySet = keySets.get(issuer);
    }
    const { payload } = await jwtVerify(token, keySet, {
      issuer, audience, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "email"], currentDate: now,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    return emails.includes(email) ? email : null;
  } catch {
    return null;
  }
}
