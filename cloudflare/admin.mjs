import { authorizedAdmin } from "./admin-auth.mjs";
import { TOKEN_IDENTITY, adminToken, checkToken, clearedCookie, sessionCookie, tokenAdmin } from "./admin-token.mjs";
import * as settings from "./settings.mjs";
import adminPage, { loginPage } from "./generated/admin-page.mjs";

const headers = {
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const LOGIN_FAILED = '<div role="alert" class="alert alert-soft alert-error text-sm">That token is not valid.</div>';
const PAGE_SIZE = 50;

/** Either sign-in method: an admin token session (containers) or Cloudflare Access. */
export async function authorizeAdmin(request, env) {
  return (await tokenAdmin(request, env)) || (await authorizedAdmin(request, env));
}

function html(body, status = 200, extra = {}) {
  // The login page posts a form to itself, so it alone allows form-action 'self'.
  const csp = headers["Content-Security-Policy"].replace("form-action 'none'", "form-action 'self'");
  return new Response(body, { status, headers: { ...headers, "Content-Security-Policy": csp, "Content-Type": "text/html; charset=utf-8", ...extra } });
}

function redirect(location, extra = {}) {
  return new Response(null, { status: 303, headers: { ...headers, Location: location, ...extra } });
}

async function tokenSignIn(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  if (path === "/admin/login" && (method === "GET" || method === "HEAD")) return html(loginPage.replace("__ERROR__", ""));
  if (request.headers.get("Origin") !== url.origin) return error("Cross-site request refused.", 403);
  if (path === "/admin/logout" && method === "POST") return redirect("/admin/login", { "Set-Cookie": clearedCookie(url) });
  if (path === "/admin/login" && method === "POST") {
    const form = await request.formData().catch(() => null);
    if (!(await checkToken(form?.get("token"), env))) return html(loginPage.replace("__ERROR__", LOGIN_FAILED), 401);
    return redirect("/admin", { "Set-Cookie": await sessionCookie(env, url) });
  }
  return error("Method not allowed.", 405);
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function json(value, status = 200) {
  return new Response(JSON.stringify(value) + "\n", { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

function error(message, status) { return json({ error: message }, status); }

async function body(request) {
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) throw new settings.InputError("Send JSON.");
  const text = await request.text();
  if (text.length > 16384) throw new settings.InputError("Request is too large.");
  try { return JSON.parse(text); } catch { throw new settings.InputError("Request is not valid JSON."); }
}

async function listPastes(env, url) {
  const now = Math.floor(Date.now() / 1000);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 64);
  const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  let filter = "WHERE (expires_at = 0 OR expires_at > ?)";
  const values = [now];
  // An address-looking query matches the creator IP exactly; anything else matches an ID prefix.
  if (/^[0-9a-fA-F.:]+$/.test(query) && /[.:]/.test(query)) { filter += " AND creator_ip = ?"; values.push(query); }
  else if (query) { filter += " AND id LIKE ? ESCAPE '\\'"; values.push(query.replace(/[\\%_]/g, "\\$&") + "%"); }
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`SELECT id, lang, size, created_at, expires_at, burn, encrypted, creator_ip, country, client
      FROM pastes ${filter} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM pastes ${filter}`).bind(...values),
  ]);
  return { pastes: rows.results, total: count.results[0].total, page, page_size: PAGE_SIZE };
}

async function statistics(env, url) {
  const days = Math.max(7, Math.min(90, Number.parseInt(url.searchParams.get("days") || "30", 10) || 30));
  const now = Math.floor(Date.now() / 1000);
  const since = new Date((now - (days - 1) * 86400) * 1000).toISOString().slice(0, 10);
  const [daily, languages, clients, active, allTime] = await env.DB.batch([
    env.DB.prepare("SELECT day, SUM(pastes) AS pastes, SUM(bytes) AS bytes FROM paste_stats WHERE day >= ? GROUP BY day ORDER BY day").bind(since),
    env.DB.prepare("SELECT lang, SUM(pastes) AS pastes FROM paste_stats WHERE day >= ? GROUP BY lang ORDER BY pastes DESC LIMIT 8").bind(since),
    env.DB.prepare("SELECT client, SUM(pastes) AS pastes FROM paste_stats WHERE day >= ? GROUP BY client").bind(since),
    env.DB.prepare("SELECT COUNT(*) AS pastes, COALESCE(SUM(size), 0) AS bytes, COUNT(DISTINCT creator_ip) AS creators FROM pastes WHERE expires_at = 0 OR expires_at > ?").bind(now),
    env.DB.prepare("SELECT COALESCE(SUM(pastes), 0) AS pastes FROM paste_stats"),
  ]);
  // Fill missing days so the chart has one bar per day.
  const byDay = new Map(daily.results.map((row) => [row.day, row]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date((now - i * 86400) * 1000).toISOString().slice(0, 10);
    series.push({ day, pastes: byDay.get(day)?.pastes || 0, bytes: byDay.get(day)?.bytes || 0 });
  }
  return {
    days, series, languages: languages.results,
    clients: Object.fromEntries(clients.results.map((row) => [row.client, row.pastes])),
    active: active.results[0], all_time: allTime.results[0].pastes,
  };
}

/** Handles /admin and /admin/*; returns null for other paths. */
export async function adminResponse(request, env, { authorize = authorizeAdmin, loadPaste } = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/admin" && !path.startsWith("/admin/")) return null;
  const tokenEnabled = Boolean(adminToken(env));
  if (tokenEnabled && (path === "/admin/login" || path === "/admin/logout")) return tokenSignIn(request, env, url);
  // Authenticate every other admin path before reading storage or rendering the private UI.
  const email = await authorize(request, env);
  if (!email) {
    if (tokenEnabled && (path === "/admin" || path === "/admin/") && request.method === "GET") return redirect("/admin/login");
    return error(tokenEnabled ? "Sign in with the admin token at /admin/login." : "Administrator sign-in through Cloudflare Access is required.", 403);
  }
  const method = request.method;
  // Cookies from Cloudflare Access would ride along on cross-site requests; only same-origin writes are accepted.
  if (!["GET", "HEAD"].includes(method) && request.headers.get("Origin") !== url.origin) return error("Cross-site request refused.", 403);

  try {
    if (path === "/admin" || path === "/admin/") {
      if (method !== "GET" && method !== "HEAD") return error("Method not allowed.", 405);
      return new Response(adminPage, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/admin/api/session" && method === "GET") {
      return json({ email, method: email === TOKEN_IDENTITY ? "token" : "access" });
    }
    if (path === "/admin/api/pastes" && method === "GET") return json(await listPastes(env, url));
    if (path === "/admin/api/stats" && method === "GET") return json(await statistics(env, url));
    if (path === "/admin/api/settings" && method === "GET") {
      return json({ settings: await settings.load(env, { fresh: true }), defaults: settings.defaults(env), updated: await settings.metadata(env) });
    }
    if (path === "/admin/api/settings" && method === "PUT") {
      const saved = await settings.save(env, await body(request), email);
      return json({ settings: saved, updated: await settings.metadata(env) });
    }
    if (path === "/admin/api/pastes/delete-by-ip" && method === "POST") {
      const { ip } = await body(request);
      if (typeof ip !== "string" || !/^[0-9a-fA-F.:]{3,45}$/.test(ip)) throw new settings.InputError("Enter a valid IP address.");
      // meta.changes would also count cascaded chunk rows.
      const result = await env.DB.prepare("DELETE FROM pastes WHERE creator_ip = ? RETURNING id").bind(ip).all();
      return json({ deleted: result.results.length });
    }
    const match = /^\/admin\/api\/pastes\/([^/]+)(\/raw)?$/.exec(path);
    if (match && ID.test(match[1])) {
      const [, id, raw] = match;
      if (raw && method === "GET") {
        // Admin previews never consume burn-after-reading pastes.
        const paste = await loadPaste(id, env, false);
        if (!paste) return error("Paste not found.", 404);
        return new Response(paste.bytes, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
      }
      if (!raw && method === "DELETE") {
        const result = await env.DB.prepare("DELETE FROM pastes WHERE id = ? RETURNING id").bind(id).all();
        return result.results.length ? json({ deleted: 1 }) : error("Paste not found.", 404);
      }
    }
    return error("Not found.", 404);
  } catch (failure) {
    if (failure instanceof settings.InputError) return error(failure.message, 400);
    console.error("Admin request failed.");
    return error("The admin request failed.", 500);
  }
}
