import { cors, fail, json, rateLimit, readJson, rpc, sha256, signedEntitlement } from "../../../_shared/portal.js";

export async function onRequestOptions({ request }) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function onRequestPost({ request, env }) {
  const headers = cors(request);
  try {
    const secret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret || secret.length < 40) return json({ error: "SESSION_PROOF_REQUIRED" }, 401, headers);
    if (env.PORTAL_OTP_ENABLED !== "true" && env.PORTAL_OTP_CANARY_ENABLED !== "true") return json({ error: "FEATURE_NOT_ACTIVATED", feature: "otp_pairing", message: "Sinkronisasi license belum diaktifkan untuk portal ini." }, 503, headers);
    await rateLimit(request, env, "license_sync", await sha256(secret), 20, 3600);
    const input = await readJson(request, 1_024);
    const magicBase = input?.magic_base;
    if (magicBase !== undefined && (!Number.isSafeInteger(magicBase) || magicBase < 1 || magicBase > Number.MAX_SAFE_INTEGER - 47)) return json({ error: "INVALID_MAGIC_BASE" }, 422, headers);
    const sessionHash = await sha256(secret);
    const v18k = env.PORTAL_LICENSE_RELEASE_ACK_V18K === "true";
    const result = await rpc(env, v18k ? "helix_license_sync_v18k" : "helix_license_sync", { p_session_hash: sessionHash });
    if (v18k && result.state === "PENDING_RELEASE") return json({ state: "PENDING_RELEASE", release_id: result.release_id, server_time: result.server_time, next_sync_seconds: 900 }, 200, headers);
    if (v18k && result.state === "RELEASED") return json({ state: "RELEASED", release_id: result.release_id || null, error: result.error_code || "BINDING_RELEASED", server_time: result.server_time }, 200, headers);
    if (result.state !== "ACTIVE") return json({ state: result.state, error: result.error_code || "ENTITLEMENT_BLOCKED", server_time: result.server_time }, 403, headers);
    let magicBaseStatus = "LEGACY_UNCHANGED";
    if (magicBase !== undefined) {
      const registered = await rpc(env, "helix_session_set_magic_base", { p_session_hash: sessionHash, p_magic_base: magicBase });
      magicBaseStatus = registered?.ok ? "REGISTERED" : (registered?.error_code || "REGISTRATION_FAILED");
    }
    const signed = await signedEntitlement(env, result.entitlement);
    return json({ state: "ACTIVE", entitlement: signed, telemetry_magic_base: magicBaseStatus, server_time: result.server_time, next_sync_seconds: v18k ? 900 : undefined, next_sync_hours: v18k ? undefined : 24, retry_after_seconds: v18k ? 900 : 14_400, offline_grace_hours: v18k ? 2 : 168 }, 200, headers);
  } catch (error) {
    const failed = fail(error, headers);
    if (env.PORTAL_LICENSE_RELEASE_ACK_V18K !== "true") return failed;
    const retryHeaders = new Headers(failed.headers);
    retryHeaders.set("retry-after", "900");
    return new Response(failed.body, { status: failed.status, headers: retryHeaders });
  }
}
