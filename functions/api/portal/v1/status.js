import { json } from "../../../_shared/portal.js";

const enabled = value => value === "true";

export async function onRequestGet({ env }) {
  const otp = enabled(env.PORTAL_OTP_ENABLED);
  const performance = enabled(env.PORTAL_PERFORMANCE_ENABLED) && enabled(env.EA_R7_TELEMETRY_READY);
  return json({
    status: "ok",
    features: {
      license_management: enabled(env.PORTAL_LICENSE_MANAGEMENT_ENABLED),
      otp_pairing: otp,
      email_change: enabled(env.PORTAL_EMAIL_CHANGE_ENABLED),
      trading_performance: performance,
    },
    readiness: {
      otp_pairing: otp ? "enabled" : "not_activated",
      trading_performance: performance ? "enabled" : "waiting_for_verified_ea_r7",
      r7_telemetry_verified: enabled(env.EA_R7_TELEMETRY_READY),
    },
  });
}
