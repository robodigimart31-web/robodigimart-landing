import { cors, fail, hmac, json, randomToken, rateLimit, readJson, rpc, sha256 } from "../../../../_shared/portal.js";

export async function onRequestOptions({ request }) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function onRequestPost({ request, env }) {
  const headers = cors(request);
  try {
    if (env.PORTAL_OTP_ENABLED !== "true" && env.PORTAL_OTP_CANARY_ENABLED !== "true") return json({ error: "FEATURE_NOT_ACTIVATED", feature: "otp_pairing", message: "Pairing OTP belum diaktifkan untuk portal ini." }, 503, headers);
    await rateLimit(request, env, "pair_start", request.headers.get("cf-connecting-ip") || "unknown", 20, 3600);
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415, headers);
    const input = await readJson(request, 4_096);
    const broker = String(input.broker_server || "").trim().replace(/\s+/g, " ");
    const login = String(input.account_login || "").trim();
    const mode = String(input.mode || "").toLowerCase();
    const protocol = String(input.protocol_version || "").slice(0, 24);
    const build = String(input.ea_build || "unknown").slice(0, 48);
    const product = String(input.ea_product_id || "");
    const version = String(input.ea_version || "");
    const magicBase = input.magic_base;
    if (broker.length < 2 || broker.length > 120 || /[\u0000-\u001f\u007f]/.test(broker) || !/^[0-9]{3,18}$/.test(login) || !["real", "demo"].includes(mode) || protocol !== "v2" || !/^[A-Za-z0-9._-]{1,48}$/.test(build) || !/^[a-z][a-z0-9_]{1,47}$/.test(product) || !/^\d{1,6}(?:\.\d{1,6}){1,3}[a-z]?$/i.test(version) || (magicBase !== undefined && (!Number.isSafeInteger(magicBase) || magicBase < 1 || magicBase > Number.MAX_SAFE_INTEGER - 47))) return json({ error: "INVALID_REQUEST" }, 400, headers);
    const normalizedServer = broker.toLocaleLowerCase("en-US");
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100_000_000).padStart(8, "0");
    const sessionSecret = randomToken(32);
    const codeHash = await hmac(`helix-pair:v1:${code}`, env.PAIRING_HASH_SECRET);
    const sessionHash = await sha256(sessionSecret);
    const fingerprint = await sha256(`${normalizedServer}:${login}`);
    // This public EA endpoint has no authenticated member identity. Keep the
    // legacy SHA-256 pairing protocol unchanged; canonical HMAC must be computed
    // only inside the authenticated approval path, never accepted at public start.
    const created = await rpc(env, "helix_pairing_start", {
      p_code_hash: codeHash,
      p_session_hash: sessionHash,
      p_broker_server: broker,
      p_normalized_server: normalizedServer,
      p_account_login: login,
      p_account_fingerprint: fingerprint,
      p_mode: mode,
      p_protocol_version: protocol,
      p_ea_build: build,
      p_ea_product_id: product,
      p_ea_version: version,
    });
    if (magicBase !== undefined) {
      const registered = await rpc(env, "helix_session_set_magic_base", { p_session_hash: sessionHash, p_magic_base: magicBase });
      if (!registered?.ok) return json({ error: registered?.error_code || "MAGIC_BASE_REGISTRATION_FAILED" }, 409, headers);
    }
    return json({ pairing_code: code, pairing_request_id: created.id, session_secret: sessionSecret, expires_at: created.expires_at, poll_interval_seconds: 15, protocol_version: "v2", ea_product_id: product, ea_version: version }, 201, headers);
  } catch (error) { return fail(error, headers); }
}
