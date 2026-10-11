import { cors, fail, json, rateLimit, readJson, rpc, sha256, signedEntitlement } from "../../../../_shared/portal.js";

export async function onRequestOptions({ request }) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function onRequestPost({ request, env }) {
  const headers = cors(request);
  try {
    const secret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret || secret.length < 40) return json({ error: "SESSION_PROOF_REQUIRED" }, 401, headers);
    if (env.PORTAL_OTP_ENABLED !== "true") return json({ error: "FEATURE_NOT_ACTIVATED", feature: "otp_pairing", message: "Pairing OTP belum diaktifkan untuk portal ini." }, 503, headers);
    await rateLimit(request, env, "pair_poll", await sha256(secret), 15, 60);
    await readJson(request, 1_024);
    const result = await rpc(env, "helix_pairing_poll", { p_session_hash: await sha256(secret) });
    if (result.state === "PENDING") return json({ state: "PENDING", retry_after_seconds: 15, expires_at: result.expires_at }, 200, headers);
    if (result.state !== "APPROVED") return json({ state: result.state || "REJECTED", error: result.error_code || "PAIRING_NOT_APPROVED" }, 200, headers);
    const signed = await signedEntitlement(env, result.entitlement);
    return json({ state: "APPROVED", entitlement: signed, next_sync_hours: 24, offline_grace_hours: 168 }, 200, headers);
  } catch (error) { return fail(error, headers); }
}
