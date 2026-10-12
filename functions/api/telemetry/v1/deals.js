import { cors, fail, json, rateLimit, readJson, rpc, sha256 } from "../../../_shared/portal.js";

const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e12;
const BROKER_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/;
function validBrokerTimestamp(value) {
  if (typeof value !== "string" || !BROKER_TS.test(value)) return false;
  const [date, time] = value.split("T");
  const parsed = new Date(`${date}T${time}Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value && date >= "2026-09-01";
}
function validateDeal(d, magicBase) {
  return d && typeof d === "object"
    && typeof d.deal_ticket === "string" && /^[0-9]{1,24}$/.test(d.deal_ticket)
    && typeof d.position_id === "string" && /^[0-9]{1,24}$/.test(d.position_id)
    && validBrokerTimestamp(d.occurred_at_broker)
    && ["BUY", "SELL"].includes(d.direction)
    && ["IN", "OUT"].includes(d.entry_kind)
    && typeof d.volume === "number" && Number.isFinite(d.volume) && d.volume > 0 && d.volume <= 1e6
    && ["profit", "commission", "swap", "fee"].every(key => finite(d[key]))
    && typeof d.currency === "string" && /^[A-Z]{3,6}$/.test(d.currency)
    && typeof d.symbol === "string" && /^[\w.\-]{2,30}$/.test(d.symbol)
    && Number.isSafeInteger(d.magic) && d.magic >= 0
    && (d.entry_kind === "IN" ? d.magic >= magicBase + 1 && d.magic <= magicBase + 47 : d.magic === 0 || (d.magic >= magicBase + 1 && d.magic <= magicBase + 47));
}

export async function onRequestOptions({ request }) { return new Response(null, { status: 204, headers: cors(request) }); }

export async function onRequestPost({ request, env }) {
  const headers = cors(request);
  try {
    const secret = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret || secret.length < 40) return json({ error: "SESSION_PROOF_REQUIRED" }, 401, headers);
    await rateLimit(request, env, "telemetry_ingest", await sha256(secret), 30, 600);
    const input = await readJson(request, 1_500_000);
    if (input.schema_version !== "2-broker-time" || input.time_basis !== "BROKER_SERVER" || !Number.isSafeInteger(input.magic_base) || input.magic_base < 1 || input.magic_base > Number.MAX_SAFE_INTEGER - 47 || !Array.isArray(input.deals) || input.deals.length < 1 || input.deals.length > 180 || !input.deals.every(deal => validateDeal(deal, input.magic_base))) return json({ error: "INVALID_DEALS_PAYLOAD" }, 422, headers);
    const globalEnabled = env.PORTAL_PERFORMANCE_ENABLED === "true" && env.EA_R7_TELEMETRY_READY === "true";
    if (!globalEnabled && env.PORTAL_PERFORMANCE_CANARY_ENABLED !== "true") return json({ error: "FEATURE_NOT_ACTIVATED", feature: "trading_performance", message: "Trading Performance menunggu verifikasi telemetry EA R7." }, 503, headers);
    const result = await rpc(env, "helix_ingest_telemetry_deals_v2", { p_session_hash: await sha256(secret), p_magic_base: input.magic_base, p_deals: input.deals, p_global_enabled: globalEnabled });
    if (!result.ok) return json({ error: result.error_code || "TELEMETRY_REJECTED" }, 403, headers);
    return json({ ok: true, accepted: result.accepted, updated_trades: result.updated_trades, synced_at: result.synced_at }, 200, headers);
  } catch (error) { return fail(error, headers); }
}
