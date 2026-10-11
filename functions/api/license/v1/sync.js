import { cors, fail, json, rateLimit, readJson, rpc, sha256, signedEntitlement } from "../../../_shared/portal.js";

export async function onRequestOptions({ request }) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function onRequestPost({ request, env }) {
  const headers = cors(request);
  try {
    const secret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret || secret.length < 40) return json({ error: "SESSION_PROOF_REQUIRED" }, 401, headers);
    if (env.PORTAL_OTP_ENABLED !== "true") return json({ error: "FEATURE_NOT_ACTIVATED", feature: "otp_pairing", message: "Sinkronisasi license belum diaktifkan untuk portal ini." }, 503, headers);
    await rateLimit(request, env, "license_sync", await sha256(secret), 20, 3600);
    await readJson(request, 1_024);
    const result = await rpc(env, "helix_license_sync", { p_session_hash: await sha256(secret) });
    if (result.state !== "ACTIVE") return json({ state: result.state, error: result.error_code || "ENTITLEMENT_BLOCKED", server_time: result.server_time }, 403, headers);
    const signed = await signedEntitlement(env, result.entitlement);
    return json({ state: "ACTIVE", entitlement: signed, server_time: result.server_time, next_sync_hours: 24, offline_grace_hours: 168 }, 200, headers);
  } catch (error) { return fail(error, headers); }
}
