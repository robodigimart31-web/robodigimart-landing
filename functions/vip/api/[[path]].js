const DEFAULT_SUPABASE_URL = "https://wouwoefzghecuiknznvs.supabase.co";
import { hmac, rateLimit, readJson as readBoundedJson, rpc, sha256, verifiedUser } from "../../_shared/portal.js";

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function supabase(env, path, { method = "GET", body, token } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Cloudflare Pages secret SUPABASE_SERVICE_ROLE_KEY is not configured.");
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (method !== "GET") headers.prefer = "return=representation";
  if (token) headers["x-authorization"] = `Bearer ${token}`;
  const result = await fetch(`${env.SUPABASE_URL || DEFAULT_SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await result.text();
  if (!result.ok) throw new Error(`Database request failed (${result.status}): ${text.slice(0, 350)}`);
  return text ? JSON.parse(text) : null;
}

async function listLicenses(env, filter = "") {
  const base = `helix_licenses?${filter ? `${filter}&` : ""}select=id,member_id,product_slug,status,expires_at,max_accounts,created_at,issued_at,first_activated_at,duration_days,activation_policy,last_successful_sync_at,entitlement_version&order=created_at.desc`;
  try { return await supabase(env, base); }
  catch {
    const legacy = `helix_licenses?${filter ? `${filter}&` : ""}select=id,member_id,product_slug,status,expires_at,max_accounts,created_at&order=created_at.desc`;
    return (await supabase(env, legacy)).map(item => ({ ...item, activation_policy: "legacy_fixed", first_activated_at: null, issued_at: item.created_at, duration_days: null, last_successful_sync_at: null, entitlement_version: null }));
  }
}

async function authUser(token, env) {
  if (!token) return null;
  const result = await fetch(`${env.SUPABASE_URL || DEFAULT_SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_FDLLBcmYFGiS9PDbyvgDtQ_UWUB8fUc", authorization: `Bearer ${token}` },
  });
  if (!result.ok) return null;
  return result.json();
}

async function requireUser(request, env, admin = false) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const user = await authUser(token, env);
  if (!user?.id) return { error: response({ error: "Sesi login sudah berakhir. Silakan masuk kembali." }, 401) };
  const rows = await supabase(env, `helix_members?id=eq.${encodeURIComponent(user.id)}&select=id,email,display_name,role`);
  const member = rows?.[0];
  if (!member) return { error: response({ error: "Profil member belum tersedia." }, 403) };
  let suspensions = [];
  try { suspensions = await supabase(env, `helix_member_suspensions?member_id=eq.${encodeURIComponent(user.id)}&select=member_id&limit=1`); }
  catch (error) { if (!error?.message?.includes("DATABASE_HTTP_404") && !error?.message?.includes("Database request failed (404)")) throw error; }
  if (suspensions.length) return { error: response({ error: "MEMBER_SUSPENDED", message: "Akses akun HELIX ini sedang disuspend. Hubungi HELIX TEAM." }, 403) };
  if (admin && member.role !== "admin") return { error: response({ error: "Akses admin diperlukan." }, 403) };
  return { user, member };
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  const value = [...bytes].map(x => x.toString(16).padStart(2, "0").toUpperCase()).join("");
  return `HELIX-QUA-${value.slice(0, 8)}-${value.slice(8, 16)}-${value.slice(16, 24)}-${value.slice(24, 32)}`;
}

async function adminAuth(env, path, method, body) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Cloudflare Pages secret SUPABASE_SERVICE_ROLE_KEY is not configured.");
  const result = await fetch(`${env.SUPABASE_URL || DEFAULT_SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await result.text();
  if (!result.ok) throw new Error(text.slice(0, 500));
  return text ? JSON.parse(text) : null;
}

function portalBaseUrl(env) {
  const value = String(env.PORTAL_PUBLIC_URL || "https://www.robodigimart.com").replace(/\/+$/, "");
  const url = new URL(value);
  const allowedHost = url.hostname === "robodigimart.com" || url.hostname.endsWith(".robodigimart.com") || url.hostname.endsWith(".pages.dev");
  if (url.protocol !== "https:" || !allowedHost) throw new Error("PORTAL_PUBLIC_URL is not an allowed HTTPS portal origin.");
  return url.origin;
}

async function storageRequest(env, path, { method = "GET", body, contentType = "application/json" } = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const result = await fetch(`${env.SUPABASE_URL || DEFAULT_SUPABASE_URL}/storage/v1/${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": contentType },
    body,
  });
  const text = await result.text();
  if (!result.ok) throw new Error(`Storage request failed (${result.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/vip\/api\/?/, "");
    const method = request.method;
    const licenseRoute = pathname === "admin/licenses" || pathname.startsWith("admin/licenses/") || pathname.startsWith("member/bindings/");
    const emailRoute = pathname.startsWith("member/email-change-requests") || pathname.startsWith("admin/email-change-requests");
    const otpRoute = pathname.startsWith("member/pairings/");
    const performanceRoute = pathname === "member/performance";
    if (licenseRoute && method !== "GET" && env.PORTAL_LICENSE_MANAGEMENT_ENABLED !== "true") return response({ error: "FEATURE_NOT_ACTIVATED", feature: "license_management", message: "Perubahan license menunggu migrasi database terverifikasi." }, 503);
    if (emailRoute && env.PORTAL_EMAIL_CHANGE_ENABLED !== "true") return response({ error: "FEATURE_NOT_ACTIVATED", feature: "email_change", message: "Fitur perubahan email belum diaktifkan." }, 503);
    if (otpRoute && env.PORTAL_OTP_ENABLED !== "true") return response({ error: "FEATURE_NOT_ACTIVATED", feature: "otp_pairing", message: "Pairing OTP belum diaktifkan untuk portal ini." }, 503);
    if (performanceRoute && (env.PORTAL_PERFORMANCE_ENABLED !== "true" || env.EA_R7_TELEMETRY_READY !== "true")) return response({ status: "WAITING_FOR_EA_R7", message: "Trading Performance menunggu verifikasi protokol telemetry EA R7." }, 200);
    const earlyAuthRoute = pathname.startsWith("member/pairings/") || pathname.startsWith("member/email-change-requests") || pathname === "member/performance" || pathname === "member/profile" || pathname.startsWith("admin/email-change-requests");
    const earlySession = earlyAuthRoute ? await verifiedUser(request, env, pathname.startsWith("admin/")) : null;
    if (earlySession?.error) return earlySession.error;
    const isMultipart = request.headers.get("content-type")?.includes("multipart/form-data");
    const form = isMultipart ? await request.formData() : null;
    let json = {};
    if (method !== "GET" && method !== "DELETE") {
      if (earlyAuthRoute) json = await readBoundedJson(request, 8_192);
      else json = form ? Object.fromEntries([...form.entries()].filter(([key]) => key !== "file")) : await request.json();
    }

    if (pathname === "member" && method === "GET") {
      const session = await requireUser(request, env);
      if (session.error) return session.error;
      const id = encodeURIComponent(session.user.id);
      const [licenses, announcements, materials] = await Promise.all([
        listLicenses(env, `member_id=eq.${id}`),
        supabase(env, "helix_announcements?published=eq.true&select=id,title,body,kind,published_at,created_at&order=published_at.desc.nullslast"),
        supabase(env, "helix_materials?published=eq.true&select=id,title,description,kind,storage_path,created_at&order=created_at.desc"),
      ]);
      for (const license of licenses) {
        license.effective_status = license.status !== "active" ? license.status.toUpperCase() : license.expires_at && Date.parse(license.expires_at) <= Date.now() ? "EXPIRED" : license.activation_policy === "first_activation" && !license.first_activated_at ? "PENDING ACTIVATION" : "ACTIVE";
      }
      const licenseIds = licenses.map(x => x.id);
      const bindings = licenseIds.length ? await supabase(env, `helix_license_bindings?license_id=in.(${licenseIds.join(",")})&released_at=is.null&select=id,license_id,broker_server,account_login,mode,last_sync_at,first_seen_at`) : [];
      const events = licenseIds.length ? await supabase(env, `helix_license_events?license_id=in.(${licenseIds.join(",")})&select=id,license_id,event_type,metadata,created_at&order=created_at.desc&limit=100`) : [];
      let emailChangeRequests = [];
      try { emailChangeRequests = await supabase(env, `helix_email_change_requests?member_id=eq.${id}&select=id,old_email,new_email,status,member_note,admin_note,created_at,decided_at,verified_at,expires_at&order=created_at.desc&limit=20`); } catch { /* migration pending: keep existing member pages available */ }
      return response({ member: session.member, licenses, bindings, events, announcements, materials, emailChangeRequests });
    }

    if (pathname === "member/profile" && method === "PATCH") {
      const session = earlySession;
      const displayName = String(json.display_name || "").trim().replace(/\s+/g, " ");
      if (displayName.length < 2 || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) return response({ error: "Nama harus 2–80 karakter dan tidak boleh berisi karakter kontrol." }, 400);
      const updated = await supabase(env, `helix_members?id=eq.${encodeURIComponent(session.user.id)}&select=id,email,display_name,role`, { method: "PATCH", body: { display_name: displayName } });
      if (!updated?.[0]) return response({ error: "Profil member tidak ditemukan." }, 404);
      return response({ ok: true, member: updated[0] });
    }

    if (pathname === "member/pairings/lookup" && method === "POST") {
      const session = earlySession;
      await rateLimit(request, env, "pair_lookup", `${request.headers.get("cf-connecting-ip") || "unknown"}:${session.user.id}`, 15, 600);
      const code = String(json.pairing_code || "").trim();
      const licenseId = String(json.license_id || "");
      if (!/^\d{8}$/.test(code) || !/^[0-9a-f-]{36}$/i.test(licenseId)) return response({ error: "INVALID_PAIRING" }, 400);
      const result = await rpc(env, "helix_pairing_lookup", { p_code_hash: await hmac(`helix-pair:v1:${code}`, env.PAIRING_HASH_SECRET), p_member_id: session.user.id, p_license_id: licenseId });
      if (!result?.ok) return response({ error: result?.error_code || "INVALID_PAIRING" }, 400);
      return response({ pairing: result });
    }

    if (pathname === "member/pairings/approve" && method === "POST") {
      const session = earlySession;
      await rateLimit(request, env, "pair_approve", `${request.headers.get("cf-connecting-ip") || "unknown"}:${session.user.id}`, 8, 600);
      const code = String(json.pairing_code || "").trim();
      const licenseId = String(json.license_id || "");
      if (!/^\d{8}$/.test(code) || !/^[0-9a-f-]{36}$/i.test(licenseId) || json.confirmed !== true) return response({ error: "CONFIRMATION_REQUIRED" }, 400);
      const result = await rpc(env, "helix_pairing_approve", { p_code_hash: await hmac(`helix-pair:v1:${code}`, env.PAIRING_HASH_SECRET), p_license_id: licenseId, p_member_id: session.user.id, p_actor_id: session.user.id });
      if (!result?.ok) return response({ error: result?.error_code || "PAIRING_REJECTED" }, 400);
      return response({ ok: true, state: result.state, binding_id: result.binding_id, message: "Akun MT5 berhasil dipasangkan. EA akan menerima entitlement saat polling berikutnya." });
    }

    if (pathname === "member/performance" && method === "GET") {
      const session = earlySession;
      const uuid = /^[0-9a-f-]{36}$/i;
      const licenseId = url.searchParams.get("license_id");
      const bindingId = url.searchParams.get("binding_id");
      const fromValue = url.searchParams.get("from");
      const toValue = url.searchParams.get("to");
      const family = url.searchParams.get("family");
      if ((licenseId && !uuid.test(licenseId)) || (bindingId && !uuid.test(bindingId)) || (family && family !== "unclassified")) return response({ error: "INVALID_FILTER" }, 400);
      const from = fromValue ? new Date(fromValue) : null;
      const to = toValue ? new Date(toValue) : null;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from >= to) || (from && to && to - from > 366 * 86400000)) return response({ error: "INVALID_DATE_RANGE" }, 400);
      const summary = await rpc(env, "helix_member_performance_summary", { p_member_id: session.user.id, p_license_id: licenseId, p_binding_id: bindingId, p_from: from?.toISOString() || null, p_to: to?.toISOString() || null, p_family: family });
      return response(summary);
    }

    if (pathname === "member/email-change-requests" && method === "GET") {
      const session = earlySession;
      const requests = await supabase(env, `helix_email_change_requests?member_id=eq.${encodeURIComponent(session.user.id)}&select=id,old_email,new_email,status,member_note,admin_note,created_at,decided_at,verified_at,expires_at&order=created_at.desc&limit=20`);
      return response({ requests });
    }

    if (pathname === "member/email-change-requests" && method === "POST") {
      const session = earlySession;
      const email = String(json.new_email || "").trim().toLowerCase();
      const note = String(json.note || "").trim().slice(0, 300);
      const result = await rpc(env, "helix_email_change_request", { p_member_id: session.user.id, p_new_email: email, p_note: note });
      return result?.ok ? response(result, 201) : response({ error: result?.error_code || "REQUEST_REJECTED" }, 400);
    }

    if (pathname === "admin/email-change-requests" && method === "GET") {
      const requests = await supabase(env, "helix_email_change_requests?select=id,member_id,old_email,new_email,status,member_note,admin_note,created_at,decided_at,verified_at,expires_at&status=in.(pending,approved_awaiting_verification)&order=created_at.asc&limit=200");
      const members = await supabase(env, "helix_members?select=id,display_name,email");
      const byId = new Map(members.map(member => [member.id, member]));
      return response({ requests: requests.map(item => ({ ...item, member: byId.get(item.member_id) || null })) });
    }

    if (pathname.startsWith("admin/email-change-requests/") && method === "POST") {
      const requestId = pathname.split("/").at(-1);
      if (!/^[0-9a-f-]{36}$/i.test(requestId) || !["approve", "reject"].includes(json.action)) return response({ error: "INVALID_REQUEST" }, 400);
      const rows = await supabase(env, `helix_email_change_requests?id=eq.${encodeURIComponent(requestId)}&select=id,member_id,new_email,status`);
      const item = rows?.[0];
      if (!item) return response({ error: "REQUEST_NOT_FOUND" }, 404);
      const decision = await rpc(env, "helix_email_change_decide", { p_request_id: requestId, p_actor_id: earlySession.user.id, p_approve: json.action === "approve", p_note: String(json.note || "").slice(0, 300) });
      if (!decision?.ok) return response({ error: decision?.error_code || "REQUEST_REJECTED" }, 400);
      return response({ ok: true, status: json.action === "approve" ? "approved_awaiting_verification" : "rejected", message: json.action === "approve" ? "Disetujui. Member perlu memulai verifikasi alamat baru dari menu profil." : "Permintaan ditolak." });
    }

    if (pathname.startsWith("member/bindings/") && method === "POST") {
      const session = await requireUser(request, env);
      if (session.error) return session.error;
      const bindingId = pathname.split("/").at(-1);
      if (!/^[0-9a-f-]{36}$/i.test(bindingId)) return response({ error: "BINDING_NOT_FOUND" }, 404);
      const result = await rpc(env, "helix_release_binding", { p_member_id: session.user.id, p_binding_id: bindingId, p_actor_id: session.user.id, p_reason: String(json.reason || "Member requested release") });
      return result?.ok ? response({ ok: true, ...result }) : response({ error: result?.error_code || "RELEASE_REJECTED" }, 404);
    }

    if (pathname === "admin" && method === "GET") {
      const session = await requireUser(request, env, true);
      if (session.error) return session.error;
      const [members, licenses, bindings, events, announcements, materials, authUsers] = await Promise.all([
        supabase(env, "helix_members?select=id,email,display_name,role,created_at&order=created_at.desc"),
        listLicenses(env),
        supabase(env, "helix_license_bindings?select=id,license_id,broker_server,account_login,mode,last_sync_at,released_at&order=first_seen_at.desc"),
        supabase(env, "helix_license_events?select=id,license_id,event_type,metadata,created_at&order=created_at.desc&limit=100"),
        supabase(env, "helix_announcements?select=id,title,body,kind,published,published_at,created_at&order=created_at.desc"),
        supabase(env, "helix_materials?select=id,title,description,kind,storage_path,published,created_at&order=created_at.desc"),
        adminAuth(env, "admin/users?page=1&per_page=1000", "GET"),
      ]);
      const authById = new Map((authUsers.users || []).map(user => [user.id, user]));
      const enrichedMembers = members.map(member => ({ ...member, banned_until: authById.get(member.id)?.banned_until || null }));
      let emailRequests = [], emailRequestsAvailable = true;
      try { emailRequests = await supabase(env, "helix_email_change_requests?select=id,member_id,old_email,new_email,status,member_note,admin_note,created_at,decided_at,verified_at,expires_at&status=in.(pending,approved_awaiting_verification)&order=created_at.asc&limit=200"); }
      catch { emailRequestsAvailable = false; }
      const membersById = new Map(enrichedMembers.map(member => [member.id, member]));
      return response({ admin: session.member, members: enrichedMembers, licenses, bindings, events, announcements, materials, emailRequests: emailRequests.map(item => ({ ...item, member: membersById.get(item.member_id) || null })), emailRequestsAvailable });
    }

    const session = await requireUser(request, env, pathname.startsWith("admin/"));
    if (session.error) return session.error;

    if (pathname === "admin/performance" && method === "GET") {
      const requestedPage = Number(url.searchParams.get("page") || 1);
      if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 1000) return response({ error: "INVALID_PAGE" }, 400);
      const page = requestedPage;
      const pageSize = 20;
      let weekStartValue = url.searchParams.get("week_start") || new Date(Date.now() - ((new Date().getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
      const monthValue = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
      const parsedWeekDate = new Date(`${weekStartValue}T00:00:00Z`);
      if (!datePattern.test(weekStartValue) || !monthPattern.test(monthValue) || Number.isNaN(parsedWeekDate.getTime()) || parsedWeekDate.toISOString().slice(0, 10) !== weekStartValue) return response({ error: "INVALID_PERFORMANCE_PERIOD" }, 400);
      const selectedWeekDate = new Date(`${weekStartValue}T00:00:00Z`);
      selectedWeekDate.setUTCDate(selectedWeekDate.getUTCDate() - ((selectedWeekDate.getUTCDay() + 6) % 7));
      weekStartValue = selectedWeekDate.toISOString().slice(0, 10);
      const weekStart = new Date(`${weekStartValue}T00:00:00+07:00`);
      const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
      const priorWeekStart = new Date(weekStart.getTime() - 7 * 86400000);
      const monthStart = new Date(`${monthValue}-01T00:00:00+07:00`);
      const [monthYear, monthNumber] = monthValue.split("-").map(Number);
      const monthEnd = new Date(Date.UTC(monthYear, monthNumber, 1) - 7 * 3600000);
      const priorMonthStart = new Date(Date.UTC(monthYear, monthNumber - 2, 1) - 7 * 3600000);
      const monthFrom = date => date.toISOString();
      const performanceEnabled = env.PORTAL_PERFORMANCE_ENABLED === "true" && env.EA_R7_TELEMETRY_READY === "true";
      if (performanceEnabled) await rateLimit(request, env, "admin_performance", session.user.id, 10, 60);
      const members = await supabase(env, `helix_members?role=eq.member&select=id,email,display_name,created_at&order=created_at.desc&limit=1000`);
      const total = members.length;
      const pageMembers = members.slice((page - 1) * pageSize, page * pageSize);
      const base = { members: pageMembers, page, page_size: pageSize, total_members: total, total_pages: Math.max(1, Math.ceil(total / pageSize)), week_start: weekStartValue, month: monthValue };
      if (!performanceEnabled) return response({ ...base, status: "WAITING_FOR_EA_R7", summaries: [], message: "Performa menunggu verifikasi EA dan aktivasi telemetry. Daftar member tetap live; tidak ada angka simulasi." });

      const windowSummary = (memberId, from, to) => rpc(env, "helix_member_performance_summary", { p_member_id: memberId, p_license_id: null, p_binding_id: null, p_from: from, p_to: to, p_family: null });
      const work = [...pageMembers];
      const summaries = [];
      const workers = Array.from({ length: Math.min(4, work.length) }, async () => {
        while (work.length) {
          const member = work.shift();
          const [all, week, previousWeek, month, previousMonth] = await Promise.all([
            windowSummary(member.id, null, null),
            windowSummary(member.id, monthFrom(weekStart), monthFrom(weekEnd)),
            windowSummary(member.id, monthFrom(priorWeekStart), monthFrom(weekStart)),
            windowSummary(member.id, monthFrom(monthStart), monthFrom(monthEnd)),
            windowSummary(member.id, monthFrom(priorMonthStart), monthFrom(monthStart)),
          ]);
          const growth = (current, previous) => {
            if (current.status === "MIXED_CURRENCY" || previous.status === "MIXED_CURRENCY") return { status: "MIXED_CURRENCY", net_pnl: null, growth_pct: null, currency: null };
            const currentPnl = current.status === "READY" ? Number(current.net_pnl) : 0;
            const previousPnl = previous.status === "READY" ? Number(previous.net_pnl) : 0;
            const currency = current.currency || previous.currency || null;
            if (current.currency && previous.currency && current.currency !== previous.currency) return { status: "MIXED_CURRENCY", net_pnl: null, growth_pct: null, currency: null };
            if (!currency) return { status: "NO_DATA", net_pnl: null, growth_pct: null, currency: null };
            const growthPct = previousPnl === 0 ? (currentPnl === 0 ? 0 : null) : Math.round(((currentPnl - previousPnl) / Math.abs(previousPnl)) * 10000) / 100;
            return { status: "READY", net_pnl: currentPnl, growth_pct: growthPct, currency };
          };
          summaries.push({ member_id: member.id, lifetime: all, weekly: growth(week, previousWeek), monthly: growth(month, previousMonth) });
        }
      });
      try { await Promise.all(workers); }
      catch (error) {
        if (error?.message?.includes("DATABASE_HTTP_404")) return response({ error: "MEMBER_PERFORMANCE_FUNCTION_MISSING", message: "Fungsi helix_member_performance_summary belum ada. Verifikasi penerapan migration telemetry dasar sebelum melanjutkan." }, 503);
        throw error;
      }
      return response({ ...base, status: "READY", summaries });
    }

    if (pathname === "admin/members" && method === "POST") {
      const email = String(json.email || "").trim().toLowerCase();
      const displayName = String(json.display_name || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return response({ error: "Alamat email tidak valid." }, 400);
      const invited = await adminAuth(env, `invite?redirect_to=${encodeURIComponent(`${portalBaseUrl(env)}/vip/login?flow=invite`)}`, "POST", {
        email, data: { full_name: displayName },
      });
      return response({ ok: true, member: invited.user || invited, message: "Undangan aktivasi dikirim ke email member." }, 201);
    }

    if (/^admin\/members\/[0-9a-f-]{36}\/role$/i.test(pathname) && method === "PATCH") {
      const targetId = pathname.split("/")[2];
      const role = String(json.role || "");
      const reason = String(json.reason || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(targetId) || !["admin", "member"].includes(role)) return response({ error: "INVALID_ROLE_CHANGE" }, 400);
      if (targetId === session.user.id) return response({ error: "SELF_ROLE_CHANGE_BLOCKED", message: "Role akun yang sedang digunakan tidak dapat diubah dari sesi ini." }, 400);
      if (reason.length < 3 || reason.length > 300) return response({ error: "REASON_REQUIRED", message: "Alasan perubahan wajib diisi (3–300 karakter)." }, 400);
      try {
        const result = await rpc(env, "helix_admin_set_member_role", { p_target_member_id: targetId, p_actor_id: session.user.id, p_role: role, p_reason: reason });
        if (!result?.ok) return response({ error: result?.error_code || "ROLE_CHANGE_FAILED" }, result?.error_code === "MEMBER_NOT_FOUND" ? 404 : 400);
        return response({ ok: true, role: result.role, unchanged: Boolean(result.unchanged) });
      } catch (error) {
        if (error?.message?.includes("DATABASE_HTTP_404")) return response({ error: "ROLE_MIGRATION_REQUIRED", message: "Fungsi audit perubahan role belum tersedia. Terapkan migration 202610110002_helix_admin_member_roles.sql terlebih dahulu." }, 503);
        throw error;
      }
    }

    if (pathname.startsWith("admin/members/") && method === "DELETE") {
      const id = pathname.split("/").at(-1);
      if (id === session.user.id) return response({ error: "Admin tidak dapat menghapus akunnya sendiri dari portal." }, 400);
      const target = await supabase(env, `helix_members?id=eq.${encodeURIComponent(id)}&select=role`);
      if (!target.length) return response({ error: "Member tidak ditemukan." }, 404);
      if (target[0].role === "admin") return response({ error: "Akun admin hanya dapat dikelola melalui prosedur administrator terpisah." }, 400);
      await adminAuth(env, `admin/users/${encodeURIComponent(id)}`, "DELETE");
      return response({ ok: true });
    }

    if (pathname.startsWith("admin/members/") && method === "POST") {
      const id = pathname.split("/").at(-1);
      if (json.action === "reset") {
        const rows = await supabase(env, `helix_members?id=eq.${encodeURIComponent(id)}&select=email`);
        if (!rows.length) return response({ error: "Member tidak ditemukan." }, 404);
        await adminAuth(env, `recover?redirect_to=${encodeURIComponent(`${portalBaseUrl(env)}/vip/login?flow=recovery`)}`, "POST", { email: rows[0].email, gotrue_meta_security: {} });
        return response({ ok: true, message: "Link reset password dikirim lewat HELIX TEAM." });
      }
      if (json.action === "suspend" || json.action === "unsuspend") {
        const target = await supabase(env, `helix_members?id=eq.${encodeURIComponent(id)}&select=id,role`);
        if (!target.length) return response({ error: "Member tidak ditemukan." }, 404);
        if (target[0].role === "admin") return response({ error: "Akun admin tidak dapat disuspend dari menu Member." }, 400);
        const reason = String(json.reason || "").trim();
        if (reason.length < 3 || reason.length > 300) return response({ error: "Alasan suspend/pemulihan wajib diisi (3–300 karakter)." }, 400);
        const suspended = json.action === "suspend";
        let licenseResult;
        try {
          licenseResult = await rpc(env, "helix_admin_set_member_suspended", { p_member_id: id, p_actor_id: session.user.id, p_suspended: suspended, p_reason: reason });
        } catch (error) {
          if (error?.message?.includes("DATABASE_HTTP_404")) return response({ error: "MEMBER_ACCESS_MIGRATION_REQUIRED", message: "Blokir license dan sesi EA belum tersedia. Terapkan migration 202610110003_helix_member_license_suspend.sql terlebih dahulu." }, 503);
          throw error;
        }
        if (!licenseResult?.ok) return response({ error: licenseResult?.error_code || "MEMBER_ACCESS_UPDATE_FAILED" }, 400);
        try {
          await adminAuth(env, `admin/users/${encodeURIComponent(id)}`, "PUT", { ban_duration: suspended ? "876000h" : "none" });
        } catch (error) {
          return response({ error: "LICENSE_ACCESS_UPDATED_AUTH_UPDATE_FAILED", message: suspended ? "License dan sesi EA sudah diblokir, tetapi pemblokiran login portal gagal. Coba ulangi tindakan suspend." : "License sudah dipulihkan dan sesi lama dicabut, tetapi pemulihan login portal gagal. Periksa status akun Auth." }, 503);
        }
        return response({ ok: true, licenses_changed: licenseResult.licenses_changed, sessions_revoked: licenseResult.sessions_revoked });
      }
    }

    if (pathname === "admin/licenses" && method === "POST") {
      const email = String(json.email || "").trim().toLowerCase();
      const idempotencyKey = String(json.idempotency_key || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) return response({ error: "INVALID_IDEMPOTENCY_KEY" }, 400);
      const memberRows = await supabase(env, `helix_members?email=eq.${encodeURIComponent(email)}&select=id,email`);
      if (!memberRows.length) return response({ error: "Buat/invite member lebih dulu sebelum membuat license." }, 400);
      const expiryDays = json.expiry_days === undefined ? 730 : Number(json.expiry_days);
      const maxAccounts = json.max_accounts === undefined ? 5 : Number(json.max_accounts);
      if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 3650 || !Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 5) return response({ error: "Masa aktif harus 1–3650 hari dan slot harus 1–5." }, 400);
      if (String(json.product_slug || "quadriga") !== "quadriga") return response({ error: "Produk license belum tersedia." }, 400);
      const internalLegacyValue = randomKey();
      const hash = await digest(internalLegacyValue);
      const created = await rpc(env, "helix_admin_create_license", { p_member_id: memberRows[0].id, p_actor_id: session.user.id, p_product_slug: String(json.product_slug || "quadriga"), p_legacy_hash: hash, p_duration_days: expiryDays, p_max_accounts: maxAccounts, p_idempotency_key: idempotencyKey, p_memo: String(json.memo || "").slice(0,300) });
      if (!created?.ok) return response({ error: created?.error_code || "LICENSE_CREATE_FAILED" }, 400);
      return response({ ok: true, license: created.license, activation: created.activation, duration_days: expiryDays }, created.idempotent ? 200 : 201);
    }

    if (pathname.startsWith("admin/licenses/") && method === "PATCH") {
      const id = pathname.split("/").at(-1);
      if (json.action === "rotate-key") {
        return response({ error: "LEGACY_KEY_DISABLED", message: "Customer authentication menggunakan pairing OTP. License key manual tidak diterbitkan." }, 410);
      }
      if (json.action === "release-slot") {
        if (String(json.reason || "").trim().length < 3) return response({ error: "Alasan pelepasan slot wajib diisi (minimal 3 karakter)." }, 400);
        const rows = await supabase(env, `helix_license_bindings?id=eq.${encodeURIComponent(json.binding_id)}&license_id=eq.${encodeURIComponent(id)}&select=id,license_id,helix_licenses!inner(member_id)`);
        const binding = rows?.[0];
        if (!binding) return response({ error: "BINDING_NOT_FOUND" }, 404);
        const result = await rpc(env, "helix_release_binding", { p_member_id: binding.helix_licenses.member_id, p_binding_id: binding.id, p_actor_id: session.user.id, p_reason: String(json.reason).trim().slice(0,300) });
        return result?.ok ? response({ ok: true, result }) : response({ error: result?.error_code || "RELEASE_REJECTED" }, 400);
      }
      if (json.action === "renew") {
        const days = Number(json.duration_days || 730);
        if (!Number.isInteger(days) || days < 1 || days > 3650) return response({ error: "INVALID_DURATION" }, 400);
        const reason = String(json.reason || "").trim();
        if (reason.length < 3) return response({ error: "REASON_REQUIRED" }, 400);
        const renewed = await rpc(env, "helix_admin_update_license", { p_license_id: id, p_actor_id: session.user.id, p_status: null, p_max_accounts: null, p_expires_at: null, p_duration_days: days, p_reason: reason.slice(0,300) });
        return renewed?.ok ? response({ ok: true, license: renewed.license }) : response({ error: renewed?.error_code || "LICENSE_UPDATE_FAILED" }, 400);
      }
      let status = null;
      if (json.status !== undefined) {
        if (!["active", "suspended", "revoked", "expired"].includes(json.status)) return response({ error: "INVALID_STATUS" }, 400);
        status = json.status;
      }
      let slots = null;
      if (json.max_accounts !== undefined) {
        slots = Number(json.max_accounts);
        if (!Number.isInteger(slots) || slots < 1 || slots > 5) return response({ error: "Batas slot harus bilangan bulat antara 1 sampai 5." }, 400);
      }
      let expiry = null;
      if (json.expires_at) {
        const parsed = new Date(json.expires_at);
        if (Number.isNaN(parsed.getTime())) return response({ error: "Tanggal expiry tidak valid." }, 400);
        expiry = parsed.toISOString();
      }
      const duration = json.duration_days === undefined ? null : Number(json.duration_days);
      if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 3650)) return response({ error: "INVALID_DURATION" }, 400);
      const reason = String(json.reason || "").trim();
      if (reason.length < 3) return response({ error: "REASON_REQUIRED" }, 400);
      const updated = await rpc(env, "helix_admin_update_license", { p_license_id: id, p_actor_id: session.user.id, p_status: status, p_max_accounts: slots, p_expires_at: expiry, p_duration_days: duration, p_reason: reason.slice(0,300) });
      if (!updated?.ok) return response({ error: updated?.error_code || "LICENSE_UPDATE_FAILED", ...(updated?.error_code === "ACTIVE_SLOTS_EXCEED_LIMIT" ? { active_slots: updated.active_slots } : {}) }, updated?.error_code === "LICENSE_NOT_FOUND" ? 404 : updated?.error_code === "ACTIVE_SLOTS_EXCEED_LIMIT" ? 409 : 400);
      return response({ ok: true, license: updated.license });
    }

    if (pathname === "admin/announcements" && method === "POST") {
      const row = { title: String(json.title || "").trim(), body: String(json.body || "").trim(), kind: json.kind || "update", published: Boolean(json.published), published_at: json.published ? new Date().toISOString() : null, created_by: session.user.id };
      if (!row.title || !row.body) return response({ error: "Judul dan isi pengumuman wajib diisi." }, 400);
      const created = await supabase(env, "helix_announcements?select=*", { method: "POST", body: row });
      return response({ ok: true, item: created[0] }, 201);
    }

    if (pathname.startsWith("admin/announcements/") && method === "DELETE") {
      const id = pathname.split("/").at(-1);
      await supabase(env, `helix_announcements?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return response({ ok: true });
    }

    if (pathname.startsWith("admin/announcements/") && method === "PATCH") {
      const id = pathname.split("/").at(-1);
      const published = Boolean(json.published);
      const updated = await supabase(env, `helix_announcements?id=eq.${encodeURIComponent(id)}&select=id,published,published_at`, { method: "PATCH", body: { published, published_at: published ? new Date().toISOString() : null } });
      return response({ ok: true, item: updated?.[0] });
    }

    if (pathname === "admin/materials" && method === "POST") {
      const row = { title: String(json.title || "").trim(), description: String(json.description || "").trim(), kind: json.kind || "guide", storage_path: json.storage_path || null, published: Boolean(json.published), created_by: session.user.id };
      if (!row.title) return response({ error: "Nama material wajib diisi." }, 400);
      const file = form?.get("file");
      if (file && typeof file.arrayBuffer === "function" && file.size > 0) {
        if (file.size > 50 * 1024 * 1024) return response({ error: "Ukuran file maksimum 50 MB." }, 400);
        const extension = file.name.split(".").pop()?.toLowerCase() || "";
        if (!/^(pdf|mp4|zip|ex5|png|jpe?g|webp|txt|mq5)$/.test(extension)) return response({ error: "Jenis file yang didukung: PDF, MP4, ZIP, EX5, PNG, JPG, WEBP, TXT, MQ5." }, 400);
        const bucket = "helix-vip-materials";
        try { await storageRequest(env, `bucket/${bucket}`); }
        catch { await storageRequest(env, "bucket", { method: "POST", body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 52428800, allowed_mime_types: ["application/pdf", "video/mp4", "application/zip", "application/x-zip-compressed", "application/octet-stream", "image/png", "image/jpeg", "image/webp", "text/plain"] }) }); }
        const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-90) || `material.${extension}`;
        const objectPath = `${crypto.randomUUID()}/${filename}`;
        await storageRequest(env, `object/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", body: file, contentType: file.type || "application/octet-stream" });
        row.storage_path = `${bucket}:${objectPath}`;
      }
      if (row.storage_path) {
        if (!row.storage_path.startsWith("helix-vip-materials:")) {
          let link;
          try { link = new URL(row.storage_path); } catch { return response({ error: "URL material tidak valid." }, 400); }
          if (link.protocol !== "https:") return response({ error: "URL material harus menggunakan HTTPS." }, 400);
        }
      }
      const created = await supabase(env, "helix_materials?select=*", { method: "POST", body: row });
      return response({ ok: true, item: created[0] }, 201);
    }

    if (pathname.startsWith("admin/materials/") && method === "DELETE") {
      const id = pathname.split("/").at(-1);
      const material = await supabase(env, `helix_materials?id=eq.${encodeURIComponent(id)}&select=storage_path`);
      if (material[0]?.storage_path?.startsWith("helix-vip-materials:")) {
        const objectPath = material[0].storage_path.split(":").slice(1).join(":");
        await storageRequest(env, "object/helix-vip-materials", { method: "DELETE", body: JSON.stringify({ prefixes: [objectPath] }) });
      }
      await supabase(env, `helix_materials?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return response({ ok: true });
    }

    if (pathname.startsWith("member/materials/") && method === "GET") {
      const memberSession = await requireUser(request, env);
      if (memberSession.error) return memberSession.error;
      const id = pathname.split("/").at(-1);
      const rows = await supabase(env, `helix_materials?id=eq.${encodeURIComponent(id)}&published=eq.true&select=storage_path,title`);
      if (!rows.length || !rows[0].storage_path) return response({ error: "File material tidak ditemukan." }, 404);
      const storage = rows[0].storage_path;
      if (!storage.startsWith("helix-vip-materials:")) {
        let external;
        try { external = new URL(storage); } catch { return response({ error: "URL file tidak valid." }, 400); }
        if (external.protocol !== "https:") return response({ error: "URL file tidak aman." }, 400);
        return response({ url: external.href });
      }
      const [, objectPath] = storage.split(":", 2);
      const signed = await storageRequest(env, `object/sign/helix-vip-materials/${objectPath.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", body: JSON.stringify({ expiresIn: 600 }) });
      const signedPath = signed.signedURL || signed.signedUrl;
      const fileUrl = new URL(signedPath.startsWith("http") ? signedPath : `${env.SUPABASE_URL || DEFAULT_SUPABASE_URL}/storage/v1${signedPath}`);
      fileUrl.searchParams.set("download", "");
      return response({ url: fileUrl.toString() });
    }

    if (pathname.startsWith("admin/materials/") && method === "PATCH") {
      const id = pathname.split("/").at(-1);
      const updated = await supabase(env, `helix_materials?id=eq.${encodeURIComponent(id)}&select=id,published`, { method: "PATCH", body: { published: Boolean(json.published) } });
      return response({ ok: true, item: updated?.[0] });
    }

    return response({ error: "Endpoint tidak ditemukan." }, 404);
  } catch (error) {
    if (error?.status === 429) return response({ error: "RATE_LIMITED", retry_after_seconds: error.retryAfter || 60 }, 429);
    return response({ error: "Permintaan belum berhasil diproses. Periksa konfigurasi HELIX TEAM/Pages Functions lalu coba lagi." }, error?.status === 503 ? 503 : 500);
  }
}
