export const SUPABASE_URL = "https://wouwoefzghecuiknznvs.supabase.co";

export const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extraHeaders },
});

export async function readJson(request, maxBytes = 16_384) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw Object.assign(new Error("PAYLOAD_TOO_LARGE"), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw Object.assign(new Error("PAYLOAD_TOO_LARGE"), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("INVALID_JSON"), { status: 400 }); }
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmac(value, secret) {
  if (!secret || new TextEncoder().encode(secret).length < 32) throw Object.assign(new Error("PAIRING_HASH_SECRET_NOT_CONFIGURED"), { status: 503 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const value of data) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export async function db(env, path, { method = "GET", body } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw Object.assign(new Error("DATABASE_NOT_CONFIGURED"), { status: 503 });
  const result = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", ...(method === "POST" ? { prefer: "return=representation" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await result.text();
  if (!result.ok) throw Object.assign(new Error(`DATABASE_HTTP_${result.status}`), { status: result.status >= 500 ? 503 : 400 });
  return text ? JSON.parse(text) : null;
}

export async function rpc(env, name, args) {
  return db(env, `rpc/${name}`, { method: "POST", body: args });
}

export async function rateLimit(request, env, bucket, subject, limit, windowSeconds) {
  const hash = await hmac(`helix-rate:v1:${bucket}:${subject}`, env.PAIRING_HASH_SECRET);
  const result = await rpc(env, "helix_rate_limit", { p_bucket: bucket, p_subject_hash: hash, p_limit: limit, p_window_seconds: windowSeconds });
  if (!result?.allowed) throw Object.assign(new Error("RATE_LIMITED"), { status: 429, retryAfter: Number(result?.retry_after_seconds || windowSeconds) });
  return result;
}

export async function verifiedUser(request, env, admin = false) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return { error: json({ error: "AUTH_REQUIRED", message: "Silakan masuk kembali." }, 401) };
  const auth = await fetch(`${env.SUPABASE_URL || SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_FDLLBcmYFGiS9PDbyvgDtQ_UWUB8fUc", authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!auth.ok) return { error: json({ error: "AUTH_REQUIRED", message: "Sesi login tidak valid." }, 401) };
  const user = await auth.json();
  const rows = await db(env, `helix_members?id=eq.${encodeURIComponent(user.id)}&select=id,email,display_name,role`);
  const member = rows?.[0];
  if (!member) return { error: json({ error: "MEMBER_NOT_FOUND" }, 403) };
  let suspensions = [];
  try { suspensions = await db(env, `helix_member_suspensions?member_id=eq.${encodeURIComponent(user.id)}&select=member_id&limit=1`); }
  catch (error) { if (error?.message !== "DATABASE_HTTP_404") throw error; }
  if (suspensions.length) return { error: json({ error: "MEMBER_SUSPENDED", message: "Akses akun HELIX ini sedang disuspend. Hubungi HELIX TEAM." }, 403) };
  if (admin && member.role !== "admin") return { error: json({ error: "ADMIN_REQUIRED" }, 403) };
  return { user, member };
}

function decodeBase64(value) {
  const binary = atob(value.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ""));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export const LICENSE_SIGNING_KEY_ID = "helix-ed25519-5a081266524f5068";
export const LICENSE_SIGNING_PUBLIC_KEY_HEX = "5321c9f73fe4dec6f662d75b7def108262b6ddf9c3681f815ff9df965eb32fa7";

const canonicalIso = (value, field, nullable = false) => {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw Object.assign(new Error(`INVALID_${field.toUpperCase()}`), { status: 422 });
  return new Date(value).toISOString();
};

export function canonicalEntitlementPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("INVALID_ENTITLEMENT"), { status: 422 });
  const allowedProducts = input.allowed_products;
  if (allowedProducts !== "all" && (!Array.isArray(allowedProducts) || !allowedProducts.length || !allowedProducts.every(value => typeof value === "string" && /^[a-z][a-z0-9_]{1,47}$/.test(value)))) {
    throw Object.assign(new Error("INVALID_ALLOWED_PRODUCTS"), { status: 422 });
  }
  const claims = {
    protocol_version: "v2",
    key_id: LICENSE_SIGNING_KEY_ID,
    algorithm: "Ed25519",
    license_scope: input.license_scope,
    license_id: input.license_id,
    binding_id: input.binding_id,
    account_fingerprint: input.account_fingerprint,
    status: input.status,
    license_expires_at: canonicalIso(input.license_expires_at, "license_expires_at", true),
    entitlement_version: input.entitlement_version,
    ea_product_id: input.ea_product_id,
    ea_version: input.ea_version,
    allowed_products: allowedProducts === "all" ? "all" : [...new Set(allowedProducts)].sort(),
    issued_at: canonicalIso(input.issued_at, "issued_at"),
    server_time: canonicalIso(input.server_time, "server_time"),
    offline_expires_at: canonicalIso(input.offline_expires_at, "offline_expires_at"),
  };
  const issuedAt = Date.parse(claims.issued_at);
  const serverTime = Date.parse(claims.server_time);
  const offlineExpiry = Date.parse(claims.offline_expires_at);
  if (!["helix_suite", "product"].includes(claims.license_scope)
    || !/^[0-9a-f-]{36}$/i.test(claims.license_id || "")
    || !/^[0-9a-f-]{36}$/i.test(claims.binding_id || "")
    || !/^[0-9a-f]{64}$/.test(claims.account_fingerprint || "")
    || !["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"].includes(claims.status)
    || !Number.isSafeInteger(claims.entitlement_version) || claims.entitlement_version < 1
    || !/^[a-z][a-z0-9_]{1,47}$/.test(claims.ea_product_id || "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(claims.ea_version || "")
    || issuedAt > serverTime || offlineExpiry < issuedAt
    || (claims.license_expires_at !== null && offlineExpiry > Date.parse(claims.license_expires_at))) {
    throw Object.assign(new Error("INVALID_ENTITLEMENT_CLAIMS"), { status: 422 });
  }
  if (claims.allowed_products !== "all" && !claims.allowed_products.includes(claims.ea_product_id)) {
    throw Object.assign(new Error("PRODUCT_NOT_ALLOWED"), { status: 403 });
  }
  return claims;
}

export function validateEntitlementPolicy(claims, expected, now = Date.now()) {
  if (!claims || !expected || typeof expected !== "object") return "INVALID_ENTITLEMENT";
  if (claims.status !== "ACTIVE") return claims.status === "SUSPENDED" ? "LICENSE_SUSPENDED" : claims.status === "REVOKED" ? "LICENSE_REVOKED" : "LICENSE_NOT_ACTIVE";
  const licenseExpiry = claims.license_expires_at === null ? null : Date.parse(claims.license_expires_at);
  if (licenseExpiry !== null && (!Number.isFinite(licenseExpiry) || licenseExpiry <= now)) return "LICENSE_EXPIRED";
  const offlineExpiry = Date.parse(claims.offline_expires_at);
  if (!Number.isFinite(offlineExpiry) || offlineExpiry <= now) return "OFFLINE_GRACE_EXPIRED";
  if (claims.account_fingerprint !== expected.account_fingerprint) return "ACCOUNT_MISMATCH";
  if (expected.product_is_registered !== true || claims.ea_product_id !== expected.ea_product_id) return "PRODUCT_NOT_ALLOWED";
  if (claims.allowed_products !== "all" && !claims.allowed_products?.includes(expected.ea_product_id)) return "PRODUCT_NOT_ALLOWED";
  if (claims.ea_version !== expected.ea_version) return "EA_VERSION_NOT_ALLOWED";
  if (!Number.isSafeInteger(claims.entitlement_version) || claims.entitlement_version < (expected.minimum_entitlement_version || 1)) return "STALE_ENTITLEMENT";
  return null;
}

const base64Url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");

export async function signedEntitlement(env, payload) {
  const encodedKey = env.LICENSE_SIGNING_PRIVATE_KEY_PKCS8;
  if (!encodedKey) throw Object.assign(new Error("LICENSE_SIGNING_KEY_NOT_CONFIGURED"), { status: 503 });
  const key = await crypto.subtle.importKey("pkcs8", decodeBase64(encodedKey), { name: "Ed25519" }, false, ["sign"]);
  const canonical = canonicalEntitlementPayload(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, bytes);
  return { payload: canonical, payload_utf8_base64url: base64Url(bytes), algorithm: "Ed25519", key_id: LICENSE_SIGNING_KEY_ID, signature: base64Url(new Uint8Array(signature)) };
}

export function cors(request) {
  const origin = request.headers.get("origin");
  const allowed = new Set(["https://www.robodigimart.com", "https://robodigimart.com", "https://vipmember.robodigimart.com"]);
  return origin && allowed.has(origin) ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "authorization, content-type", vary: "Origin" } : {};
}

export function fail(error, extraHeaders = {}) {
  const status = error?.status || 503;
  return json({ error: status === 503 ? "SERVICE_UNAVAILABLE" : error?.message || "REQUEST_FAILED", message: status === 503 ? "Layanan lisensi sementara tidak tersedia." : status === 429 ? "Terlalu banyak permintaan. Coba lagi setelah jeda." : "Permintaan tidak dapat diproses.", ...(status === 429 ? { retry_after_seconds: error.retryAfter } : {}) }, status, extraHeaders);
}
