import { cors, fail, json, rateLimit, readJson, rpc, sha256 } from "../../../_shared/portal.js";

const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
function validateDeal(d) {
  return d && typeof d === "object"
    && typeof d.deal_ticket === "string" && /^[0-9]{1,24}$/.test(d.deal_ticket)
    && typeof d.position_id === "string" && /^[0-9]{1,24}$/.test(d.position_id)
    && typeof d.occurred_at === "string" && Number.isFinite(Date.parse(d.occurred_at))
    && ["BUY", "SELL"].includes(d.direction)
    && ["IN", "OUT", "INOUT"].includes(d.entry_kind)
    && typeof d.volume === "number" && Number.isFinite(d.volume) && d.volume > 0 && d.volume <= 1e6
    && ["profit", "commission", "swap", "fee"].every(key => finite(d[key]))
    && typeof d.currency === "string" && /^[A-Z]{3,6}$/.test(d.currency)
    && typeof d.symbol === "string" && /^[\w.\-]{2,30}$/.test(d.symbol)
    && Number.isSafeInteger(d.magic) && d.magic >= 0;
}

export async function onRequestOptions({ request }) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function onRequestPost({ request, env }) {
  const headers = cors(request);
  try {
    const secret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret || secret.length < 40) return json({ error: "SESSION_PROOF_REQUIRED" }, 401, headers);
    if (env.PORTAL_PERFORMANCE_ENABLED !== "true" || env.EA_R7_TELEMETRY_READY !== "true") return json({ error: "FEATURE_NOT_ACTIVATED", feature: "trading_performance", message: "Trading Performance menunggu verifikasi protokol EA R7." }, 503, headers);
    await rateLimit(request, env, "telemetry_ingest", await sha256(secret), 30, 600);
    const input = await readJson(request, 1_500_000);
    if (!Array.isArray(input.deals) || input.deals.length < 1 || input.deals.length > 2_000 || !input.deals.every(validateDeal)) return json({ error: "INVALID_DEALS_PAYLOAD" }, 422, headers);
    const result = await rpc(env, "helix_ingest_telemetry_deals", { p_session_hash: await sha256(secret), p_deals: input.deals });
    if (!result.ok) return json({ error: result.error_code || "TELEMETRY_REJECTED" }, 403, headers);
    return json({ ok: true, accepted: result.accepted, updated_trades: result.updated_trades, synced_at: result.synced_at }, 200, headers);
  } catch (error) { return fail(error, headers); }
}
