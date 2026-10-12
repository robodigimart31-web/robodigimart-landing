import { cors, fail, json, rateLimit, readJson, rpc, sha256 } from "../../../../_shared/portal.js";

export async function onRequestOptions({ request }) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function onRequestPost({ request, env }) {
  const headers = cors(request);
  try {
    if (env.PORTAL_LICENSE_RELEASE_ACK_V18K !== "true") return json({ error: "FEATURE_NOT_ACTIVATED", feature: "license_release_ack_v18k" }, 503, headers);
    const secret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret || secret.length < 40) return json({ error: "SESSION_PROOF_REQUIRED" }, 401, headers);
    const input = await readJson(request, 1_024);
    if (!/^[0-9a-f-]{36}$/i.test(input?.release_id || "")) return json({ error: "INVALID_RELEASE_ID" }, 422, headers);
    if (input?.pending_orders_clean !== true) return json({ error: "PENDING_ORDERS_NOT_CLEARED" }, 422, headers);
    const sessionHash = await sha256(secret);
    await rateLimit(request, env, "license_release_ack", sessionHash, 10, 3600);
    const result = await rpc(env, "helix_release_ack_v18k", {
      p_session_hash: sessionHash,
      p_release_id: input.release_id,
      p_pending_orders_clean: input.pending_orders_clean,
    });
    if (!result?.ok) {
      const status = result?.error_code === "SESSION_INVALID" || result?.error_code === "SESSION_REVOKED" ? 401 : 409;
      return json({ state: "REJECTED", error: result?.error_code || "RELEASE_ACK_REJECTED" }, status, headers);
    }
    return json({ state: result.state, release_id: result.release_id, idempotent: Boolean(result.idempotent), acked_sessions: result.acked_sessions, required_sessions: result.required_sessions, released_at: result.released_at }, 200, headers);
  } catch (error) { return fail(error, headers); }
}
