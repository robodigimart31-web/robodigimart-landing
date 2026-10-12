import { cors, fail, json, rateLimit, readJson, rpc, sha256, signedEntitlement } from "../../../../_shared/portal.js";

export async function onRequestOptions({ request }) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function onRequestPost({ request, env }) {
  const headers = cors(request);
  try {
    const secret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret || secret.length < 40) return json({ error: "SESSION_PROOF_REQUIRED" }, 401, headers);
    if (env.PORTAL_OTP_ENABLED !== "true" && env.PORTAL_OTP_CANARY_ENABLED !== "true") return json({ error: "FEATURE_NOT_ACTIVATED", feature: "otp_pairing", message: "Pairing OTP belum diaktifkan untuk portal ini." }, 503, headers);
    await rateLimit(request, env, "pair_poll", await sha256(secret), 15, 60);
    await readJson(request, 1_024);
    const result = await rpc(env, "helix_pairing_poll", { p_session_hash: await sha256(secret) });
    if (result.state === "PENDING") return json({ state: "PENDING", retry_after_seconds: 15, expires_at: result.expires_at }, 200, headers);
    if (result.state !== "APPROVED") return json({ state: result.state || "REJECTED", error: result.error_code || "PAIRING_NOT_APPROVED" }, 200, headers);
    const v18k = env.PORTAL_LICENSE_RELEASE_ACK_V18K === "true";
    let claims = result.entitlement;
    if (v18k) {
      const now = Date.now();
      const hardExpiry = claims.license_expires_at ? Date.parse(claims.license_expires_at) : now + 120 * 60_000;
      claims = { ...claims, offline_expires_at: new Date(Math.min(now + 120 * 60_000, hardExpiry)).toISOString() };
    }
    const signed = await signedEntitlement(env, claims);
    return json({ state: "APPROVED", entitlement: signed, next_sync_seconds: v18k ? 900 : undefined, next_sync_hours: v18k ? undefined : 24, retry_after_seconds: v18k ? 900 : 14_400, offline_grace_hours: v18k ? 2 : 168 }, 200, headers);
  } catch (error) { return fail(error, headers); }
}
