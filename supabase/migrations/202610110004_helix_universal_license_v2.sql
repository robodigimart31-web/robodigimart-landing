-- Additive Universal Licensing v2. Does not change existing license identity/expiry.
begin;

create table if not exists public.helix_ea_products (
  ea_product_id text primary key check (ea_product_id ~ '^[a-z][a-z0-9_]{1,47}$'),
  display_name text not null,
  enabled boolean not null default false,
  min_version text,
  max_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.helix_ea_products(ea_product_id,display_name,enabled)
select slug,name,true from public.helix_series where slug='quadriga'
on conflict(ea_product_id) do nothing;

create table if not exists public.helix_license_product_policies (
  license_id uuid primary key references public.helix_licenses(id) on delete cascade,
  license_scope text not null check (license_scope in ('helix_suite','product')),
  allowed_products text[] not null default '{}',
  updated_at timestamptz not null default now(),
  check ((license_scope='helix_suite' and cardinality(allowed_products)=0) or
         (license_scope='product' and cardinality(allowed_products)>0))
);
-- Existing licenses remain restricted to the product they already name.
insert into public.helix_license_product_policies(license_id,license_scope,allowed_products)
select l.id,'product',array[l.product_slug] from public.helix_licenses l
on conflict(license_id) do nothing;

alter table public.helix_pairing_requests
  add column if not exists ea_product_id text,
  add column if not exists ea_version text;
update public.helix_pairing_requests set ea_product_id='quadriga', ea_version=coalesce(nullif(ea_build,''),'unknown')
where ea_product_id is null or ea_version is null;
alter table public.helix_pairing_requests alter column ea_product_id set not null;
alter table public.helix_pairing_requests alter column ea_version set not null;
alter table public.helix_license_sessions
  add column if not exists ea_product_id text,
  add column if not exists ea_version text,
  add column if not exists is_canary boolean not null default false,
  add column if not exists expires_at timestamptz not null default (now()+interval '365 days');
update public.helix_license_sessions s set ea_product_id=p.ea_product_id,ea_version=p.ea_version
from public.helix_pairing_requests p where s.pairing_request_id=p.id and (s.ea_product_id is null or s.ea_version is null);
alter table public.helix_license_sessions alter column ea_product_id set not null;
alter table public.helix_license_sessions alter column ea_version set not null;
create index if not exists helix_license_sessions_product_idx on public.helix_license_sessions(license_id,binding_id,ea_product_id,ea_version) where revoked_at is null;
create index if not exists helix_pairing_product_idx on public.helix_pairing_requests(ea_product_id,ea_version,created_at desc);

create table if not exists public.helix_license_canary_allowlist (
  license_id uuid primary key references public.helix_licenses(id) on delete cascade,
  member_id uuid not null references public.helix_members(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.helix_ea_products enable row level security;
alter table public.helix_license_product_policies enable row level security;
alter table public.helix_license_canary_allowlist enable row level security;
revoke all on public.helix_ea_products,public.helix_license_product_policies,public.helix_license_canary_allowlist from anon,authenticated;
grant select,insert,update,delete on public.helix_ea_products,public.helix_license_product_policies,public.helix_license_canary_allowlist to service_role;

create or replace function public.helix_pairing_start(
  p_code_hash text,p_session_hash text,p_broker_server text,p_normalized_server text,
  p_account_login text,p_account_fingerprint text,p_mode text,p_protocol_version text,p_ea_build text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  raise exception 'PROTOCOL_VERSION_UNSUPPORTED';
end $$;

-- Retire the old product-blind application overloads. The API must use v2 args.
create or replace function public.helix_pairing_lookup(p_code_hash text,p_member_id uuid,p_license_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin return jsonb_build_object('ok',false,'error_code','PROTOCOL_VERSION_UNSUPPORTED'); end $$;
create or replace function public.helix_pairing_approve(p_code_hash text,p_license_id uuid,p_member_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin return jsonb_build_object('ok',false,'error_code','PROTOCOL_VERSION_UNSUPPORTED'); end $$;

create or replace function public.helix_pairing_start(
  p_code_hash text,p_session_hash text,p_broker_server text,p_normalized_server text,
  p_account_login text,p_account_fingerprint text,p_mode text,p_protocol_version text,
  p_ea_build text,p_ea_product_id text,p_ea_version text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_expires timestamptz;
begin
  if p_protocol_version<>'v2' or length(p_code_hash)<>64 or length(p_session_hash)<>64 or length(p_account_fingerprint)<>64
     or p_mode not in ('real','demo') or length(trim(p_broker_server)) not between 2 and 120
     or p_account_login !~ '^[0-9]{3,18}$' or p_normalized_server<>lower(trim(p_broker_server))
     or p_ea_product_id !~ '^[a-z][a-z0-9_]{1,47}$' or p_ea_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'
     or p_ea_build !~ '^[A-Za-z0-9._-]{1,48}$' then raise exception 'INVALID_REQUEST'; end if;
  if not exists(select 1 from public.helix_ea_products where ea_product_id=p_ea_product_id and enabled
    and (min_version is null or p_ea_version>=min_version) and (max_version is null or p_ea_version<=max_version)) then
    raise exception 'PRODUCT_NOT_ALLOWED';
  end if;
  insert into public.helix_pairing_requests(code_hash,session_secret_hash,broker_server,normalized_server,account_login,account_fingerprint,mode,protocol_version,ea_build,ea_product_id,ea_version)
  values(p_code_hash,p_session_hash,trim(p_broker_server),lower(trim(p_normalized_server)),trim(p_account_login),p_account_fingerprint,p_mode,'v2',left(p_ea_build,48),p_ea_product_id,p_ea_version)
  returning id,expires_at into v_id,v_expires;
  return jsonb_build_object('id',v_id,'expires_at',v_expires);
end $$;

create or replace function public.helix_pairing_lookup(p_code_hash text,p_member_id uuid,p_license_id uuid,p_canary boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pair public.helix_pairing_requests; v_license public.helix_licenses; v_policy public.helix_license_product_policies;
begin
  select * into v_pair from public.helix_pairing_requests where code_hash=p_code_hash for update;
  if not found or v_pair.protocol_version<>'v2' or v_pair.state<>'pending' or v_pair.expires_at<=now() or v_pair.attempts>=10 then return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  select * into v_license from public.helix_licenses where id=p_license_id and member_id=p_member_id for share;
  if not found then update public.helix_pairing_requests set attempts=attempts+1 where id=v_pair.id; return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  select * into v_policy from public.helix_license_product_policies where license_id=v_license.id;
  if p_canary and not exists(select 1 from public.helix_license_canary_allowlist c where c.license_id=v_license.id and c.member_id=p_member_id and c.expires_at>now()) then return jsonb_build_object('ok',false,'error_code','CANARY_NOT_ALLOWED'); end if;
  if not found or not exists(select 1 from public.helix_ea_products where ea_product_id=v_pair.ea_product_id and enabled)
     or (v_policy.license_scope='product' and not (v_pair.ea_product_id=any(v_policy.allowed_products))) then
    return jsonb_build_object('ok',false,'error_code','PRODUCT_NOT_ALLOWED');
  end if;
  if v_license.status<>'active' or (v_license.expires_at is not null and v_license.expires_at<=now()) then return jsonb_build_object('ok',false,'error_code','LICENSE_NOT_ACTIVE'); end if;
  return jsonb_build_object('ok',true,'pairing_request_id',v_pair.id,'broker_server',v_pair.broker_server,'account_login',v_pair.account_login,'mode',v_pair.mode,'ea_product_id',v_pair.ea_product_id,'ea_version',v_pair.ea_version,'expires_at',v_pair.expires_at,'license_id',v_license.id,'license_hint',v_license.license_key_hint);
end $$;

create or replace function public.helix_pairing_approve(p_code_hash text,p_license_id uuid,p_member_id uuid,p_actor_id uuid,p_canary boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pair public.helix_pairing_requests; v_license public.helix_licenses; v_binding public.helix_license_bindings; v_policy public.helix_license_product_policies; v_slots integer; v_now timestamptz:=now(); v_activated boolean:=false; v_reactivated boolean:=false;
begin
  select * into v_pair from public.helix_pairing_requests where code_hash=p_code_hash for update;
  if not found or v_pair.protocol_version<>'v2' then return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  if v_pair.state='approved' then
    if v_pair.member_id<>p_member_id or v_pair.license_id<>p_license_id then return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
    return jsonb_build_object('ok',true,'state','APPROVED','binding_id',v_pair.binding_id,'license_id',v_pair.license_id,'idempotent',true);
  end if;
  if v_pair.state<>'pending' then return jsonb_build_object('ok',false,'error_code',case when v_pair.expires_at<=v_now then 'PAIRING_EXPIRED' else 'PAIRING_CONSUMED' end); end if;
  if v_pair.expires_at<=v_now or v_pair.attempts>=10 then update public.helix_pairing_requests set state='expired' where id=v_pair.id; return jsonb_build_object('ok',false,'error_code','PAIRING_EXPIRED'); end if;
  select * into v_license from public.helix_licenses where id=p_license_id and member_id=p_member_id for update;
  if not found then update public.helix_pairing_requests set attempts=attempts+1 where id=v_pair.id; return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  select * into v_policy from public.helix_license_product_policies where license_id=v_license.id;
  if p_canary and not exists(select 1 from public.helix_license_canary_allowlist c where c.license_id=v_license.id and c.member_id=p_member_id and c.expires_at>v_now) then return jsonb_build_object('ok',false,'error_code','CANARY_NOT_ALLOWED'); end if;
  if not found or not exists(select 1 from public.helix_ea_products where ea_product_id=v_pair.ea_product_id and enabled)
     or (v_policy.license_scope='product' and not (v_pair.ea_product_id=any(v_policy.allowed_products))) then return jsonb_build_object('ok',false,'error_code','PRODUCT_NOT_ALLOWED'); end if;
  if v_license.status<>'active' then return jsonb_build_object('ok',false,'error_code',case v_license.status when 'suspended' then 'LICENSE_SUSPENDED' when 'revoked' then 'LICENSE_REVOKED' else 'LICENSE_NOT_ACTIVE' end); end if;
  if v_license.expires_at is not null and v_license.expires_at<=v_now then return jsonb_build_object('ok',false,'error_code','LICENSE_EXPIRED'); end if;
  select * into v_binding from public.helix_license_bindings where license_id=v_license.id and account_fingerprint=v_pair.account_fingerprint for update;
  if not found then
    select count(*) into v_slots from public.helix_license_bindings where license_id=v_license.id and released_at is null;
    if v_slots>=least(v_license.max_accounts,5) then return jsonb_build_object('ok',false,'error_code','ACCOUNT_LIMIT_REACHED'); end if;
    insert into public.helix_license_bindings(license_id,broker_server,account_login,account_fingerprint,mode) values(v_license.id,v_pair.broker_server,v_pair.account_login,v_pair.account_fingerprint,v_pair.mode) returning * into v_binding;
  else
    if v_binding.released_at is not null then
      select count(*) into v_slots from public.helix_license_bindings where license_id=v_license.id and released_at is null;
      if v_slots>=least(v_license.max_accounts,5) then return jsonb_build_object('ok',false,'error_code','ACCOUNT_LIMIT_REACHED'); end if;
      v_reactivated:=true;
      update public.helix_license_sessions set revoked_at=coalesce(revoked_at,v_now),revoke_reason=coalesce(revoke_reason,'binding_released') where binding_id=v_binding.id;
    end if;
    update public.helix_license_bindings set broker_server=v_pair.broker_server,account_login=v_pair.account_login,mode=v_pair.mode,last_sync_at=v_now,released_at=null where id=v_binding.id returning * into v_binding;
  end if;
  if v_license.activation_policy='first_activation' and v_license.first_activated_at is null then
    update public.helix_licenses set first_activated_at=v_now,issued_at=coalesce(issued_at,v_now),expires_at=v_now+make_interval(days=>coalesce(duration_days,730)),entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id returning * into v_license;
    v_activated:=true;
  else update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id returning * into v_license; end if;
  update public.helix_pairing_requests set state='approved',member_id=p_member_id,license_id=v_license.id,binding_id=v_binding.id,approved_at=v_now where id=v_pair.id;
  insert into public.helix_license_sessions(pairing_request_id,license_id,binding_id,session_secret_hash,ea_product_id,ea_version,is_canary,expires_at) values(v_pair.id,v_license.id,v_binding.id,v_pair.session_secret_hash,v_pair.ea_product_id,v_pair.ea_version,p_canary,least(v_now+interval '365 days',coalesce(v_license.expires_at,v_now+interval '365 days'))) on conflict(pairing_request_id) do nothing;
  insert into public.helix_license_events(license_id,actor_id,event_type,binding_id,metadata) values(v_license.id,p_actor_id,case when v_activated then 'activated'::public.helix_event_type else 'sync'::public.helix_event_type end,v_binding.id,jsonb_build_object('source','otp_pairing_v2','binding_reactivated',v_reactivated,'ea_product_id',v_pair.ea_product_id));
  return jsonb_build_object('ok',true,'state','APPROVED','binding_id',v_binding.id,'license_id',v_license.id,'entitlement_version',v_license.entitlement_version);
end $$;

create or replace function public.helix_v2_entitlement(p_license public.helix_licenses,p_binding public.helix_license_bindings,p_policy public.helix_license_product_policies,p_session public.helix_license_sessions,p_now timestamptz)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('protocol_version','v2','license_scope',p_policy.license_scope,'license_id',p_license.id,'binding_id',p_binding.id,
    'account_fingerprint',p_binding.account_fingerprint,'status',upper(p_license.status::text),'license_expires_at',p_license.expires_at,
    'entitlement_version',p_license.entitlement_version,'ea_product_id',p_session.ea_product_id,'ea_version',p_session.ea_version,
    'allowed_products',case when p_policy.license_scope='helix_suite' then to_jsonb('all'::text) else to_jsonb(p_policy.allowed_products) end,
    'issued_at',p_now,'server_time',p_now,'offline_expires_at',least(p_now+interval '7 days',coalesce(p_license.expires_at,p_now+interval '7 days')))
$$;

create or replace function public.helix_pairing_poll(p_session_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pair public.helix_pairing_requests; v_session public.helix_license_sessions; v_license public.helix_licenses; v_binding public.helix_license_bindings; v_policy public.helix_license_product_policies; v_now timestamptz:=now();
begin
  select * into v_pair from public.helix_pairing_requests where session_secret_hash=p_session_hash;
  if not found or v_pair.protocol_version<>'v2' then return jsonb_build_object('state','REJECTED','error_code','INVALID_SESSION'); end if;
  if v_pair.state='pending' and v_pair.expires_at<=v_now then update public.helix_pairing_requests set state='expired' where id=v_pair.id; return jsonb_build_object('state','EXPIRED','error_code','PAIRING_EXPIRED'); end if;
  if v_pair.state='pending' then return jsonb_build_object('state','PENDING','expires_at',v_pair.expires_at); end if;
  if v_pair.state<>'approved' then return jsonb_build_object('state',upper(v_pair.state),'error_code','PAIRING_NOT_APPROVED'); end if;
  select * into v_session from public.helix_license_sessions where pairing_request_id=v_pair.id and session_secret_hash=p_session_hash and revoked_at is null;
  if not found then return jsonb_build_object('state','REJECTED','error_code','SESSION_REVOKED'); end if;
  if v_session.expires_at<=v_now then return jsonb_build_object('state','REJECTED','error_code','SESSION_EXPIRED'); end if;
  select * into v_license from public.helix_licenses where id=v_session.license_id for update;
  if v_session.is_canary and not exists(select 1 from public.helix_license_canary_allowlist c where c.license_id=v_session.license_id and c.member_id=v_pair.member_id and c.expires_at>v_now) then return jsonb_build_object('state','REVOKED','error_code','CANARY_NOT_ALLOWED'); end if;
  select * into v_binding from public.helix_license_bindings where id=v_session.binding_id for update;
  select * into v_policy from public.helix_license_product_policies where license_id=v_license.id;
  if not found or v_binding.released_at is not null then return jsonb_build_object('state','REJECTED','error_code','BINDING_RELEASED'); end if;
  if v_license.status<>'active' then return jsonb_build_object('state',upper(v_license.status::text),'error_code',case v_license.status when 'suspended' then 'LICENSE_SUSPENDED' when 'revoked' then 'LICENSE_REVOKED' else 'LICENSE_NOT_ACTIVE' end); end if;
  if v_license.expires_at is not null and v_license.expires_at<=v_now then return jsonb_build_object('state','EXPIRED','error_code','LICENSE_EXPIRED'); end if;
  update public.helix_license_sessions set last_seen_at=v_now,last_successful_sync_at=v_now where id=v_session.id;
  update public.helix_license_bindings set last_sync_at=v_now where id=v_binding.id;
  return jsonb_build_object('state','APPROVED','entitlement',public.helix_v2_entitlement(v_license,v_binding,v_policy,v_session,v_now));
end $$;

create or replace function public.helix_license_sync(p_session_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_session public.helix_license_sessions; v_license public.helix_licenses; v_binding public.helix_license_bindings; v_policy public.helix_license_product_policies; v_now timestamptz:=now();
begin
  select * into v_session from public.helix_license_sessions where session_secret_hash=p_session_hash;
  if not found or v_session.revoked_at is not null then return jsonb_build_object('state','REVOKED','error_code','SESSION_REVOKED','server_time',v_now); end if;
  if v_session.expires_at<=v_now then return jsonb_build_object('state','REVOKED','error_code','SESSION_EXPIRED','server_time',v_now); end if;
  select * into v_license from public.helix_licenses where id=v_session.license_id for update;
  if v_session.is_canary and not exists(select 1 from public.helix_license_canary_allowlist c join public.helix_pairing_requests p on p.id=v_session.pairing_request_id where c.license_id=v_session.license_id and c.member_id=p.member_id and c.expires_at>v_now) then return jsonb_build_object('state','REVOKED','error_code','CANARY_NOT_ALLOWED','server_time',v_now); end if;
  select * into v_session from public.helix_license_sessions where id=v_session.id and revoked_at is null for update;
  if not found then return jsonb_build_object('state','REVOKED','error_code','SESSION_REVOKED','server_time',v_now); end if;
  select * into v_binding from public.helix_license_bindings where id=v_session.binding_id for update;
  if not found or v_binding.released_at is not null then return jsonb_build_object('state','REVOKED','error_code','BINDING_RELEASED','server_time',v_now); end if;
  select * into v_policy from public.helix_license_product_policies where license_id=v_license.id;
  if not found or not exists(select 1 from public.helix_ea_products p where p.ea_product_id=v_session.ea_product_id and p.enabled) or (v_policy.license_scope='product' and not (v_session.ea_product_id=any(v_policy.allowed_products))) then return jsonb_build_object('state','REVOKED','error_code','PRODUCT_NOT_ALLOWED','server_time',v_now); end if;
  if v_license.status<>'active' then return jsonb_build_object('state',upper(v_license.status::text),'error_code',case v_license.status when 'suspended' then 'LICENSE_SUSPENDED' when 'revoked' then 'LICENSE_REVOKED' else 'LICENSE_NOT_ACTIVE' end,'server_time',v_now); end if;
  if v_license.expires_at is not null and v_license.expires_at<=v_now then
    update public.helix_licenses set status='expired',entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id returning * into v_license;
    insert into public.helix_license_events(license_id,event_type,metadata) values(v_license.id,'expired','{"source":"license_sync_v2"}'::jsonb);
    return jsonb_build_object('state','EXPIRED','error_code','LICENSE_EXPIRED','server_time',v_now);
  end if;
  update public.helix_license_sessions set last_seen_at=v_now,last_successful_sync_at=v_now where id=v_session.id;
  update public.helix_license_bindings set last_sync_at=v_now where id=v_binding.id;
  update public.helix_licenses set last_successful_sync_at=v_now where id=v_license.id returning * into v_license;
  return jsonb_build_object('state','ACTIVE','server_time',v_now,'entitlement',public.helix_v2_entitlement(v_license,v_binding,v_policy,v_session,v_now));
end $$;

create or replace function public.helix_touch_binding(p_license uuid,p_server text,p_login text,p_mode text default 'real')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_license public.helix_licenses; v_binding public.helix_license_bindings; v_fp text; v_slots integer;
begin
  select * into v_license from public.helix_licenses where id=p_license for update;
  if not found or v_license.status<>'active' or v_license.expires_at is null or v_license.expires_at<=now() then raise exception 'LICENSE_NOT_ACTIVE'; end if;
  v_fp:=encode(digest(lower(trim(p_server))||':'||trim(p_login),'sha256'),'hex');
  select * into v_binding from public.helix_license_bindings where license_id=p_license and account_fingerprint=v_fp for update;
  if found and v_binding.released_at is not null then
    select count(*) into v_slots from public.helix_license_bindings where license_id=p_license and released_at is null;
    if v_slots>=least(v_license.max_accounts,5) then raise exception 'ACCOUNT_LIMIT_REACHED'; end if;
    update public.helix_license_sessions set revoked_at=coalesce(revoked_at,now()),revoke_reason=coalesce(revoke_reason,'binding_released') where binding_id=v_binding.id;
    update public.helix_license_bindings set released_at=null,last_sync_at=now() where id=v_binding.id returning * into v_binding;
  elsif not found then
    select count(*) into v_slots from public.helix_license_bindings where license_id=p_license and released_at is null;
    if v_slots>=least(v_license.max_accounts,5) then raise exception 'ACCOUNT_LIMIT_REACHED'; end if;
    insert into public.helix_license_bindings(license_id,broker_server,account_login,account_fingerprint,mode) values(p_license,trim(p_server),trim(p_login),v_fp,p_mode) returning * into v_binding;
  end if;
  return jsonb_build_object('status','active','license_id',p_license,'binding_id',v_binding.id,'entitlement_version',v_license.entitlement_version);
end $$;

do $$ declare f text; begin
  foreach f in array array['helix_v2_entitlement(helix_licenses,helix_license_bindings,helix_license_product_policies,helix_license_sessions,timestamptz)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
  foreach f in array array['helix_pairing_start(text,text,text,text,text,text,text,text,text)','helix_pairing_start(text,text,text,text,text,text,text,text,text,text,text)','helix_pairing_lookup(text,uuid,uuid,boolean)','helix_pairing_approve(text,uuid,uuid,uuid,boolean)','helix_pairing_poll(text)','helix_license_sync(text)','helix_touch_binding(uuid,text,text,text)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
  revoke all on function public.helix_pairing_lookup(text,uuid,uuid) from public,anon,authenticated,service_role;
  revoke all on function public.helix_pairing_approve(text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
end $$;
commit;
