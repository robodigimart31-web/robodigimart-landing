const SUPABASE_URL = "https://wouwoefzghecuiknznvs.supabase.co";

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
  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await result.text();
  if (!result.ok) throw new Error(`Database request failed (${result.status}): ${text.slice(0, 350)}`);
  return text ? JSON.parse(text) : null;
}

async function authUser(token, env) {
  if (!token) return null;
  const result = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
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
  const result = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await result.text();
  if (!result.ok) throw new Error(text.slice(0, 500));
  return text ? JSON.parse(text) : null;
}

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/vip\/api\/?/, "");
    const method = request.method;
    const json = method === "GET" || method === "DELETE" ? {} : await request.json();

    if (pathname === "member" && method === "GET") {
      const session = await requireUser(request, env);
      if (session.error) return session.error;
      const id = encodeURIComponent(session.user.id);
      const [licenses, announcements, materials] = await Promise.all([
        supabase(env, `helix_licenses?member_id=eq.${id}&select=id,product_slug,license_key_hint,status,expires_at,max_accounts,created_at&order=created_at.desc`),
        supabase(env, "helix_announcements?published=eq.true&select=id,title,body,kind,published_at,created_at&order=published_at.desc.nullslast"),
        supabase(env, "helix_materials?published=eq.true&select=id,title,description,kind,storage_path,created_at&order=created_at.desc"),
      ]);
      const licenseIds = licenses.map(x => x.id);
      const bindings = licenseIds.length ? await supabase(env, `helix_license_bindings?license_id=in.(${licenseIds.join(",")})&released_at=is.null&select=id,license_id,broker_server,account_login,mode,last_sync_at,first_seen_at`) : [];
      const events = licenseIds.length ? await supabase(env, `helix_license_events?license_id=in.(${licenseIds.join(",")})&select=id,license_id,event_type,metadata,created_at&order=created_at.desc&limit=100`) : [];
      return response({ member: session.member, licenses, bindings, events, announcements, materials });
    }

    if (pathname.startsWith("member/bindings/") && method === "POST") {
      const session = await requireUser(request, env);
      if (session.error) return session.error;
      const bindingId = pathname.split("/").at(-1);
      const bindings = await supabase(env, `helix_license_bindings?id=eq.${encodeURIComponent(bindingId)}&released_at=is.null&select=id,license_id,helix_licenses!inner(member_id)`);
      const binding = bindings?.[0];
      if (!binding || binding.helix_licenses?.member_id !== session.user.id) return response({ error: "Akun tidak ditemukan pada profil Anda." }, 404);
      await supabase(env, `helix_license_bindings?id=eq.${encodeURIComponent(bindingId)}&released_at=is.null`, { method: "PATCH", body: { released_at: new Date().toISOString() } });
      await supabase(env, "helix_license_events", { method: "POST", body: { license_id: binding.license_id, actor_id: session.user.id, event_type: "reset", binding_id: bindingId, metadata: { source: "member_portal_release" } } });
      return response({ ok: true });
    }

    if (pathname === "admin" && method === "GET") {
      const session = await requireUser(request, env, true);
      if (session.error) return session.error;
      const [members, licenses, bindings, events, announcements, materials, authUsers] = await Promise.all([
        supabase(env, "helix_members?select=id,email,display_name,role,created_at&order=created_at.desc"),
        supabase(env, "helix_licenses?select=id,member_id,product_slug,license_key_hint,status,expires_at,max_accounts,created_at&order=created_at.desc"),
        supabase(env, "helix_license_bindings?select=id,license_id,broker_server,account_login,mode,last_sync_at,released_at&order=first_seen_at.desc"),
        supabase(env, "helix_license_events?select=id,license_id,event_type,metadata,created_at&order=created_at.desc&limit=100"),
        supabase(env, "helix_announcements?select=id,title,body,kind,published,published_at,created_at&order=created_at.desc"),
        supabase(env, "helix_materials?select=id,title,description,kind,storage_path,published,created_at&order=created_at.desc"),
        adminAuth(env, "admin/users?page=1&per_page=1000", "GET"),
      ]);
      const authById = new Map((authUsers.users || []).map(user => [user.id, user]));
      const enrichedMembers = members.map(member => ({ ...member, banned_until: authById.get(member.id)?.banned_until || null }));
      return response({ admin: session.member, members: enrichedMembers, licenses, bindings, events, announcements, materials });
    }

    const session = await requireUser(request, env, true);
    if (session.error) return session.error;

    if (pathname === "admin/members" && method === "POST") {
      const email = String(json.email || "").trim().toLowerCase();
      const displayName = String(json.display_name || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return response({ error: "Alamat email tidak valid." }, 400);
      const invited = await adminAuth(env, `invite?redirect_to=${encodeURIComponent("https://www.robodigimart.com/vip/login?flow=invite")}`, "POST", {
        email, data: { full_name: displayName },
      });
      return response({ ok: true, member: invited.user || invited, message: "Undangan aktivasi dikirim ke email member." }, 201);
    }

    if (pathname.startsWith("admin/members/") && method === "DELETE") {
      const id = pathname.split("/").at(-1);
      if (id === session.user.id) return response({ error: "Admin tidak dapat menghapus akunnya sendiri dari portal." }, 400);
      await adminAuth(env, `admin/users/${encodeURIComponent(id)}`, "DELETE");
      return response({ ok: true });
    }

    if (pathname.startsWith("admin/members/") && method === "POST") {
      const id = pathname.split("/").at(-1);
      if (json.action === "reset") {
        const rows = await supabase(env, `helix_members?id=eq.${encodeURIComponent(id)}&select=email`);
        if (!rows.length) return response({ error: "Member tidak ditemukan." }, 404);
        await adminAuth(env, `recover?redirect_to=${encodeURIComponent("https://www.robodigimart.com/vip/login?flow=recovery")}`, "POST", { email: rows[0].email, gotrue_meta_security: {} });
        return response({ ok: true, message: "Link reset password dikirim lewat Supabase Auth." });
      }
      if (json.action === "suspend" || json.action === "unsuspend") {
        await adminAuth(env, `admin/users/${encodeURIComponent(id)}`, "PUT", { ban_duration: json.action === "suspend" ? "876000h" : "none" });
        return response({ ok: true });
      }
    }

    if (pathname === "admin/licenses" && method === "POST") {
      const email = String(json.email || "").trim().toLowerCase();
      const memberRows = await supabase(env, `helix_members?email=eq.${encodeURIComponent(email)}&select=id,email`);
      if (!memberRows.length) return response({ error: "Buat/invite member lebih dulu sebelum membuat license." }, 400);
      const expiryDays = Math.min(3650, Math.max(1, Number(json.expiry_days) || 730));
      const maxAccounts = Math.min(50, Math.max(1, Number(json.max_accounts) || 5));
      const key = randomKey();
      const hash = await digest(key);
      const expiresAt = new Date(Date.now() + expiryDays * 86400000).toISOString();
      const created = await supabase(env, "helix_licenses?select=id,member_id,product_slug,license_key_hint,status,expires_at,max_accounts,created_at", {
        method: "POST", body: { member_id: memberRows[0].id, product_slug: json.product_slug || "quadriga", license_key_hash: hash, license_key_hint: `${key.slice(0, 15)}••••`, status: "active", expires_at: expiresAt, max_accounts: maxAccounts },
      });
      await supabase(env, "helix_license_events", { method: "POST", body: { license_id: created[0].id, actor_id: session.user.id, event_type: "created", metadata: { member_email: email } } });
      return response({ ok: true, license: created[0], license_key: key }, 201);
    }

    if (pathname.startsWith("admin/licenses/") && method === "PATCH") {
      const id = pathname.split("/").at(-1);
      if (json.action === "rotate-key") {
        const current = await supabase(env, `helix_licenses?id=eq.${encodeURIComponent(id)}&select=id,entitlement_version`);
        if (!current.length) return response({ error: "License tidak ditemukan." }, 404);
        const key = randomKey();
        const updated = await supabase(env, `helix_licenses?id=eq.${encodeURIComponent(id)}&select=id,license_key_hint`, { method: "PATCH", body: { license_key_hash: await digest(key), license_key_hint: `${key.slice(0, 19)}••••`, entitlement_version: Number(current[0].entitlement_version) + 1, updated_at: new Date().toISOString() } });
        await supabase(env, "helix_license_events", { method: "POST", body: { license_id: id, actor_id: session.user.id, event_type: "created", metadata: { action: "license_key_rotated" } } });
        return response({ ok: true, license: updated?.[0], license_key: key });
      }
      if (json.action === "release-slot") {
        const result = await supabase(env, `helix_license_bindings?id=eq.${encodeURIComponent(json.binding_id)}&license_id=eq.${encodeURIComponent(id)}&released_at=is.null`, { method: "PATCH", body: { released_at: new Date().toISOString() } });
        await supabase(env, "helix_license_events", { method: "POST", body: { license_id: id, actor_id: session.user.id, event_type: "reset", metadata: { binding_id: json.binding_id } } });
        return response({ ok: true, result });
      }
      const updates = {};
      if (["active", "suspended", "revoked", "expired"].includes(json.status)) updates.status = json.status;
      if (json.max_accounts !== undefined) {
        const slots = Number(json.max_accounts);
        if (!Number.isInteger(slots) || slots < 1 || slots > 50) return response({ error: "Batas slot harus bilangan bulat antara 1 sampai 50." }, 400);
        updates.max_accounts = slots;
      }
      if (json.expires_at) {
        const expiry = new Date(json.expires_at);
        if (Number.isNaN(expiry.getTime())) return response({ error: "Tanggal expiry tidak valid." }, 400);
        updates.expires_at = expiry.toISOString();
      }
      const current = await supabase(env, `helix_licenses?id=eq.${encodeURIComponent(id)}&select=entitlement_version`);
      if (!current.length) return response({ error: "License tidak ditemukan." }, 404);
      updates.entitlement_version = Number(current[0].entitlement_version) + 1;
      updates.updated_at = new Date().toISOString();
      const result = await supabase(env, `helix_licenses?id=eq.${encodeURIComponent(id)}&select=id,status,expires_at,max_accounts,entitlement_version`, { method: "PATCH", body: updates });
      if (json.status === "suspended" || json.status === "revoked") await supabase(env, "helix_license_events", { method: "POST", body: { license_id: id, actor_id: session.user.id, event_type: json.status, metadata: {} } });
      return response({ ok: true, license: result?.[0] });
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
      if (row.storage_path) {
        let link;
        try { link = new URL(row.storage_path); } catch { return response({ error: "URL material tidak valid." }, 400); }
        if (link.protocol !== "https:") return response({ error: "URL material harus menggunakan HTTPS." }, 400);
      }
      const created = await supabase(env, "helix_materials?select=*", { method: "POST", body: row });
      return response({ ok: true, item: created[0] }, 201);
    }

    if (pathname.startsWith("admin/materials/") && method === "DELETE") {
      const id = pathname.split("/").at(-1);
      await supabase(env, `helix_materials?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return response({ ok: true });
    }

    if (pathname.startsWith("admin/materials/") && method === "PATCH") {
      const id = pathname.split("/").at(-1);
      const updated = await supabase(env, `helix_materials?id=eq.${encodeURIComponent(id)}&select=id,published`, { method: "PATCH", body: { published: Boolean(json.published) } });
      return response({ ok: true, item: updated?.[0] });
    }

    return response({ error: "Endpoint tidak ditemukan." }, 404);
  } catch (error) {
    console.error("HELIX VIP API error", error);
    return response({ error: "Permintaan belum berhasil diproses. Periksa konfigurasi Supabase/Pages Functions lalu coba lagi." }, 500);
  }
}
