-- DRAFT ONLY — do not apply to Production.
-- Based on the 2026-10-18 read-only evidence snapshot and cloudflare-landing c463a7c.
-- Requires live schema/function/privilege reconciliation, backup/restore approval,
-- and the cross-file 202610120001 migration-prefix issue to be resolved first.
-- Intentionally does not alter cron scheduling or migration history.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Preflight must resolve the two checked-in 202610120001 files and verify every
-- live prerequisite/column/constraint before this draft is converted to a migration.
-- Never register or replay 202610170001 automatically; reconcile its live RPC drift first.

-- A. Canonical product catalog: additive metadata; new products are excluded
-- from HELIX ALL unless explicitly admitted by an audited Admin operation.
create or replace function public.helix_version_compare_numeric(p_left text,p_right text)
returns integer language plpgsql immutable set search_path=pg_catalog as $$
declare v_left text[]; v_right text[]; v_i integer; v_a integer; v_b integer; v_suffix_a text; v_suffix_b text; v_rank_a integer; v_rank_b integer;
begin
  if p_left !~* '^\d{1,6}(\.\d{1,6}){1,3}[a-z]?$' or p_right !~* '^\d{1,6}(\.\d{1,6}){1,3}[a-z]?$' then return null; end if;
  v_suffix_a:=lower(substring(p_left from '([a-z])$')); v_suffix_b:=lower(substring(p_right from '([a-z])$'));
  v_left:=string_to_array(regexp_replace(p_left,'[a-z]$','','i'),'.');
  v_right:=string_to_array(regexp_replace(p_right,'[a-z]$','','i'),'.');
  for v_i in 1..greatest(cardinality(v_left),cardinality(v_right)) loop
    v_a:=coalesce(v_left[v_i]::integer,0); v_b:=coalesce(v_right[v_i]::integer,0);
    if v_a<v_b then return -1; elsif v_a>v_b then return 1; end if;
  end loop;
  v_rank_a:=case when v_suffix_a is null then 27 else ascii(v_suffix_a)-96 end;
  v_rank_b:=case when v_suffix_b is null then 27 else ascii(v_suffix_b)-96 end;
  return sign(v_rank_a-v_rank_b);
end $$;
revoke all on function public.helix_version_compare_numeric(text,text) from public,anon,authenticated;
grant execute on function public.helix_version_compare_numeric(text,text) to service_role;

alter table public.helix_ea_products
  add column if not exists description text not null default '',
  add column if not exists catalog_status text not null default 'draft',
  add column if not exists all_access_eligible boolean not null default false;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='helix_ea_products_catalog_status_check') then
    alter table public.helix_ea_products add constraint helix_ea_products_catalog_status_check
      check (catalog_status in ('draft','published','disabled','archived'));
  end if;
end $$;
do $$ begin
  if exists(select 1 from public.helix_ea_products where (min_version is not null and public.helix_version_compare_numeric(min_version,min_version) is null) or (max_version is not null and public.helix_version_compare_numeric(max_version,max_version) is null) or (min_version is not null and max_version is not null and public.helix_version_compare_numeric(min_version,max_version)>0)) then
    raise exception 'PRODUCT_VERSION_RANGE_REQUIRES_MANUAL_RECONCILIATION';
  end if;
  if not exists(select 1 from pg_constraint where conname='helix_ea_products_version_range_check') then
    alter table public.helix_ea_products add constraint helix_ea_products_version_range_check check (
      (min_version is null or public.helix_version_compare_numeric(min_version,min_version) is not null)
      and (max_version is null or public.helix_version_compare_numeric(max_version,max_version) is not null)
      and (min_version is null or max_version is null or public.helix_version_compare_numeric(min_version,max_version)<=0));
  end if;
end $$;

-- Existing enabled products stay available and are explicit members of the
-- current ALL package at cutover; future products default to not eligible.
update public.helix_ea_products
   set catalog_status=case when enabled then 'published' else catalog_status end,
       all_access_eligible=case when enabled then true else all_access_eligible end
 where enabled;

alter table public.helix_license_product_policies
  add column if not exists license_package text not null default 'dedicated';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='helix_license_product_policies_package_check') then
    alter table public.helix_license_product_policies add constraint helix_license_product_policies_package_check
      check (license_package in ('dedicated','bundle','all'));
  end if;
end $$;

-- Keep existing helix_suite policy rows intact: the v2 signed entitlement
-- serializes these as license_scope=helix_suite, allowed_products="all".
-- New products are still opt-in through all_access_eligible and the guard below.
update public.helix_license_product_policies set license_package='all' where license_scope='helix_suite';
update public.helix_license_product_policies
   set license_package=case when cardinality(allowed_products)=1 then 'dedicated' else 'bundle' end
 where license_scope='product' and license_package='dedicated' and cardinality(allowed_products)>1;

-- Preserve the legacy v2 claim shape while enforcing the current catalog
-- inclusion server-side for every OTP approval path (including legacy RPCs).
create or replace function public.helix_guard_pairing_product_scope()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_scope text; v_allowed text[];
begin
  if new.state='approved' and old.state is distinct from 'approved' and new.license_id is not null then
    if not exists(select 1 from public.helix_ea_products p where p.ea_product_id=new.ea_product_id and p.enabled and p.catalog_status='published'
       and public.helix_version_compare_numeric(new.ea_version,new.ea_version) is not null
       and (p.min_version is null or public.helix_version_compare_numeric(new.ea_version,p.min_version)>=0)
       and (p.max_version is null or public.helix_version_compare_numeric(new.ea_version,p.max_version)<=0)) then
      raise exception 'PRODUCT_VERSION_NOT_ALLOWED';
    end if;
    select license_scope,allowed_products into v_scope,v_allowed
      from public.helix_license_product_policies where license_id=new.license_id;
    if not found or v_scope is null then
      raise exception 'LICENSE_PRODUCT_POLICY_MISSING';
    elsif v_scope='product' and not coalesce(new.ea_product_id=any(v_allowed),false) then
      raise exception 'PRODUCT_NOT_ALLOWED';
    elsif v_scope='helix_suite' and not exists(
      select 1 from public.helix_ea_products p where p.ea_product_id=new.ea_product_id
       and p.enabled and p.catalog_status='published' and p.all_access_eligible
    ) then
      raise exception 'PRODUCT_NOT_ALLOWED';
    elsif v_scope not in ('product','helix_suite') then
      raise exception 'LICENSE_POLICY_INVALID';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists helix_guard_pairing_product_scope on public.helix_pairing_requests;
create trigger helix_guard_pairing_product_scope before update of state on public.helix_pairing_requests
for each row execute function public.helix_guard_pairing_product_scope();

alter table public.helix_materials
  add column if not exists ea_product_id text references public.helix_ea_products(ea_product_id) on delete restrict,
  add column if not exists file_version text not null default '',
  add column if not exists file_checksum_sha256 text not null default '';

alter table public.helix_announcements
  add column if not exists ea_product_id text references public.helix_ea_products(ea_product_id) on delete restrict;
create index if not exists helix_announcements_product_published_idx
  on public.helix_announcements(ea_product_id,published,published_at desc);

-- Member-wide capacity; do not infer or backfill capacity/account ownership in
-- this schema draft. A separately reviewed reconciliation must precede enablement.
alter table public.helix_members
  add column if not exists mt5_slot_capacity integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='helix_members_mt5_slot_capacity_check') then
    alter table public.helix_members add constraint helix_members_mt5_slot_capacity_check
      check (mt5_slot_capacity >= 0 and mt5_slot_capacity % 5 = 0);
  end if;
end $$;

insert into public.helix_general_settings(setting_key,setting_value,change_reason)
values('mt5_member_slot_max','50'::jsonb,'Proposed initial maximum; draft only, confirm centrally before use.')
on conflict(setting_key) do nothing;

create table if not exists public.helix_member_mt5_accounts (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.helix_members(id) on delete restrict,
  registry_fingerprint text not null check (registry_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Version 0 is reserved for synthetic legacy rows awaiting manual HMAC reconciliation.
  fingerprint_version smallint not null default 1 check (fingerprint_version >= 0),
  broker_server text not null,
  normalized_server text not null,
  account_login text not null,
  mode text not null check (mode in ('real','demo')),
  status text not null default 'active' check (status in ('active','pending_release','suspended','released','quarantined','unreconciled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  unique(member_id,registry_fingerprint)
);
create unique index if not exists helix_member_mt5_account_single_owner_idx
  on public.helix_member_mt5_accounts(registry_fingerprint)
  where status in ('active','pending_release','suspended','quarantined','unreconciled');
create index if not exists helix_member_mt5_accounts_member_status_idx
  on public.helix_member_mt5_accounts(member_id,status);
create unique index if not exists helix_member_mt5_accounts_member_identity_idx
  on public.helix_member_mt5_accounts(member_id,normalized_server,account_login)
  where status in ('active','pending_release','suspended','quarantined','unreconciled');

alter table public.helix_license_bindings
  add column if not exists member_mt5_account_id uuid references public.helix_member_mt5_accounts(id) on delete restrict;
alter table public.helix_pairing_requests
  add column if not exists registry_fingerprint text;

-- There is no safe transparent mapping from the legacy hash to keyed HMAC.
-- Reconcile legacy bindings manually under an approved runbook before enabling
-- universal slots; no automatic history/ownership backfill is attempted.
insert into public.helix_member_mt5_accounts(member_id,registry_fingerprint,fingerprint_version,broker_server,normalized_server,account_login,mode,status)
select l.member_id,encode(extensions.digest('helix:unreconciled:'||lower(regexp_replace(trim(b.broker_server),'[[:space:]]+',' ','g'))||':'||trim(b.account_login)||':'||l.member_id::text,'sha256'),'hex'),0,min(b.broker_server),lower(regexp_replace(trim(b.broker_server),'[[:space:]]+',' ','g')),trim(b.account_login),min(b.mode),'unreconciled'
from public.helix_license_bindings b join public.helix_licenses l on l.id=b.license_id
where (b.released_at is null or b.release_state<>'released')
  and not exists(select 1 from public.helix_license_bindings peer join public.helix_licenses pl on pl.id=peer.license_id where lower(regexp_replace(trim(peer.broker_server),'[[:space:]]+',' ','g'))=lower(regexp_replace(trim(b.broker_server),'[[:space:]]+',' ','g')) and trim(peer.account_login)=trim(b.account_login) and peer.released_at is null and pl.member_id<>l.member_id)
group by l.member_id,lower(regexp_replace(trim(b.broker_server),'[[:space:]]+',' ','g')),trim(b.account_login)
having not exists(select 1 from public.helix_member_mt5_accounts a where a.member_id=l.member_id and a.normalized_server=lower(regexp_replace(trim(min(b.broker_server)),'[[:space:]]+',' ','g')) and a.account_login=trim(min(b.account_login)));

-- Link only unambiguous legacy identities to the quarantined canonical row.
-- Cross-member SHA-256 collisions remain unlinked and require manual resolution.
update public.helix_license_bindings b
   set member_mt5_account_id=a.id
  from public.helix_licenses l, public.helix_member_mt5_accounts a
 where l.id=b.license_id and a.member_id=l.member_id
   and a.status='unreconciled'
   and a.normalized_server=lower(regexp_replace(trim(b.broker_server),'[[:space:]]+',' ','g'))
   and a.account_login=trim(b.account_login)
   and b.member_mt5_account_id is null;

-- Product-admin audit ledger is created before its RLS/grants are configured.
create table if not exists public.helix_product_events (
  id uuid primary key default gen_random_uuid(),
  ea_product_id text not null references public.helix_ea_products(ea_product_id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in ('created','published','disabled','archived','all_access_included','all_access_excluded','metadata_updated')),
  reason text not null check (length(trim(reason)) between 3 and 300),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists helix_product_events_product_time_idx on public.helix_product_events(ea_product_id,created_at desc);

create table if not exists public.helix_member_slot_events (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.helix_members(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in ('capacity_adjusted','account_claimed','account_released','account_quarantined','reconciliation')),
  idempotency_key uuid not null unique,
  capacity_delta integer not null default 0 check (capacity_delta % 5 = 0),
  capacity_before integer not null check (capacity_before >= 0 and capacity_before % 5 = 0),
  capacity_after integer not null check (capacity_after >= 0 and capacity_after % 5 = 0),
  member_mt5_account_id uuid references public.helix_member_mt5_accounts(id) on delete set null,
  reason text not null check (length(trim(reason)) between 3 and 300),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists helix_member_slot_events_member_time_idx
  on public.helix_member_slot_events(member_id,created_at desc);

-- Grandfather existing active accounts and active license holders before the
-- feature flag can be enabled. Capacity is rounded up in blocks of five and
-- the cutover is audit-logged. If existing use exceeds the configured maximum,
-- abort the migration for manual resolution instead of silently revoking access.
do $$
declare r record; v_max integer; v_used integer; v_target integer;
begin
  select (setting_value #>> '{}')::integer into v_max from public.helix_general_settings where setting_key='mt5_member_slot_max';
  if v_max is null or v_max<5 or v_max%5<>0 then raise exception 'SLOT_LIMIT_CONFIG_INVALID'; end if;
  for r in
    select m.id,m.mt5_slot_capacity,count(a.id)::integer as used
    from public.helix_members m
    left join public.helix_member_mt5_accounts a on a.member_id=m.id and a.status in ('active','pending_release','suspended','quarantined','unreconciled')
    where m.mt5_slot_capacity=0
    group by m.id,m.mt5_slot_capacity
    having count(a.id)>0 or exists(select 1 from public.helix_licenses l where l.member_id=m.id and l.deleted_at is null and l.status='active' and (l.expires_at is null or l.expires_at>now()))
    order by m.id
  loop
    v_used:=r.used;
    if v_used>v_max then raise exception 'LEGACY_ACCOUNT_USAGE_ABOVE_SLOT_MAX member=% used=% max=%',r.id,v_used,v_max; end if;
    v_target:=greatest(5,((v_used+4)/5)*5);
    update public.helix_members set mt5_slot_capacity=v_target,updated_at=now() where id=r.id;
    insert into public.helix_member_slot_events(member_id,actor_id,event_type,capacity_delta,capacity_before,capacity_after,idempotency_key,reason,metadata)
    values(r.id,null,'reconciliation',v_target,0,v_target,md5('helix-slot-cutover:'||r.id::text)::uuid,
      'Grandfathered verified legacy account usage',jsonb_build_object('legacy_accounts',v_used,'cutover_capacity',v_target))
    on conflict(idempotency_key) do nothing;
  end loop;
end $$;

-- Keep the legacy pairing RPC untouched. This narrowly scoped wrapper adds the
-- server-derived registry HMAC to the existing pairing row; the SHA-256 field
-- and every v2 client-facing contract remain byte-for-byte as before.
create or replace function public.helix_pairing_start_with_registry(
  p_code_hash text,p_session_hash text,p_broker_server text,p_normalized_server text,
  p_account_login text,p_account_fingerprint text,p_mode text,p_protocol_version text,
  p_ea_build text,p_ea_product_id text,p_ea_version text,p_registry_fingerprint text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  if p_registry_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_REGISTRY_FINGERPRINT'; end if;
  v_result:=public.helix_pairing_start(p_code_hash,p_session_hash,p_broker_server,p_normalized_server,
    p_account_login,p_account_fingerprint,p_mode,p_protocol_version,p_ea_build,p_ea_product_id,p_ea_version);
  update public.helix_pairing_requests set registry_fingerprint=p_registry_fingerprint
   where id=(v_result->>'id')::uuid and account_fingerprint=p_account_fingerprint;
  if not found then raise exception 'PAIRING_REGISTRY_IDENTITY_NOT_STORED'; end if;
  return v_result;
end $$;
revoke all on function public.helix_pairing_start_with_registry(text,text,text,text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.helix_pairing_start_with_registry(text,text,text,text,text,text,text,text,text,text,text,text) to service_role;

create or replace function public.helix_pairing_attach_registry(p_code_hash text,p_member_id uuid,p_registry_fingerprint text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pair public.helix_pairing_requests;
begin
  select * into v_pair from public.helix_pairing_requests where code_hash=p_code_hash for update;
  if not found or v_pair.state<>'pending' or v_pair.expires_at<=now() or v_pair.protocol_version<>'v2' then return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  if not exists(select 1 from public.helix_members where id=p_member_id and role in ('member','admin')) then return jsonb_build_object('ok',false,'error_code','MEMBER_NOT_FOUND'); end if;
  if p_registry_fingerprint !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok',false,'error_code','INVALID_REGISTRY_FINGERPRINT'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_registry_fingerprint,0));
  if exists(select 1 from public.helix_member_mt5_accounts a where a.registry_fingerprint=p_registry_fingerprint and a.status in ('active','pending_release','suspended','released','quarantined') and a.member_id<>p_member_id) then return jsonb_build_object('ok',false,'error_code','ACCOUNT_OWNED_BY_ANOTHER_MEMBER'); end if;
  if v_pair.member_id is not null and v_pair.member_id<>p_member_id then return jsonb_build_object('ok',false,'error_code','PAIRING_ALREADY_CLAIMED'); end if;
  update public.helix_pairing_requests set registry_fingerprint=p_registry_fingerprint,member_id=p_member_id where id=v_pair.id;
  return jsonb_build_object('ok',true,'pairing_request_id',v_pair.id);
end $$;
revoke all on function public.helix_pairing_attach_registry(text,uuid,text) from public,anon,authenticated;
grant execute on function public.helix_pairing_attach_registry(text,uuid,text) to service_role;

-- This is a migration-time assertion only. If the verified current signature
-- differs, stop and reconcile schema drift rather than replacing a protocol.
do $$ begin
  if to_regprocedure('public.helix_session_set_magic_base(text,bigint)') is null then
    raise exception 'MAGIC_BASE_RPC_SIGNATURE_NOT_VERIFIED';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='helix_license_sessions' and column_name='magic_base') then
    raise exception 'SESSION_MAGIC_BASE_COLUMN_NOT_VERIFIED';
  end if;
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='helix_license_bindings' and column_name='magic_base') then
    raise exception 'BINDING_MAGIC_BASE_COLUMN_NOT_VERIFIED';
  end if;
end $$;

create or replace function public.helix_pairing_approve_universal(
  p_code_hash text,p_license_id uuid,p_member_id uuid,p_actor_id uuid,p_canary boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_pair public.helix_pairing_requests; v_license public.helix_licenses; v_binding public.helix_license_bindings;
  v_policy public.helix_license_product_policies; v_account public.helix_member_mt5_accounts;
  v_now timestamptz:=now(); v_capacity integer; v_used integer; v_legacy_members integer; v_legacy_owner uuid; v_max_slots integer; v_needs_slot boolean:=true;
  v_activated boolean:=false; v_reactivated boolean:=false; v_existing_account boolean:=false; v_binding_exists boolean:=false;
begin
  -- Serialize approvals for a member; the global partial unique index arbitrates
  -- simultaneous attempts to claim the same account across different members.
  perform 1 from public.helix_members where id=p_member_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','MEMBER_NOT_FOUND'); end if;
  select * into v_pair from public.helix_pairing_requests where code_hash=p_code_hash for update;
  if not found or v_pair.protocol_version<>'v2' then return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  if v_pair.state='approved' then
    if v_pair.member_id<>p_member_id or v_pair.license_id<>p_license_id then return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
    return jsonb_build_object('ok',true,'state','APPROVED','binding_id',v_pair.binding_id,'license_id',v_pair.license_id,'idempotent',true);
  end if;
  if v_pair.state<>'pending' then return jsonb_build_object('ok',false,'error_code',case when v_pair.expires_at<=v_now then 'PAIRING_EXPIRED' else 'PAIRING_CONSUMED' end); end if;
  if v_pair.expires_at<=v_now or v_pair.attempts>=10 then update public.helix_pairing_requests set state='expired' where id=v_pair.id; return jsonb_build_object('ok',false,'error_code','PAIRING_EXPIRED'); end if;
  if v_pair.registry_fingerprint is null or v_pair.registry_fingerprint !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok',false,'error_code','REGISTRY_IDENTITY_REQUIRED'); end if;
  if p_actor_id is distinct from p_member_id and not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','NOT_AUTHORIZED'); end if;
  select * into v_license from public.helix_licenses where id=p_license_id and member_id=p_member_id for update;
  if not found then update public.helix_pairing_requests set attempts=attempts+1 where id=v_pair.id; return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  select * into v_policy from public.helix_license_product_policies where license_id=v_license.id;
  if p_canary and not exists(select 1 from public.helix_license_canary_allowlist c where c.license_id=v_license.id and c.member_id=p_member_id and c.expires_at>v_now) then return jsonb_build_object('ok',false,'error_code','CANARY_NOT_ALLOWED'); end if;
  if not found or not exists(select 1 from public.helix_ea_products p where p.ea_product_id=v_pair.ea_product_id and p.enabled and p.catalog_status='published'
       and public.helix_version_compare_numeric(v_pair.ea_version,v_pair.ea_version) is not null
       and (p.min_version is null or public.helix_version_compare_numeric(v_pair.ea_version,p.min_version)>=0)
       and (p.max_version is null or public.helix_version_compare_numeric(v_pair.ea_version,p.max_version)<=0)) then
    return jsonb_build_object('ok',false,'error_code','PRODUCT_NOT_ALLOWED');
  end if;
  if not found or v_policy.license_scope is null then
    return jsonb_build_object('ok',false,'error_code','LICENSE_PRODUCT_POLICY_MISSING');
  elsif v_policy.license_scope='product' and not coalesce(v_pair.ea_product_id=any(v_policy.allowed_products),false) then
    return jsonb_build_object('ok',false,'error_code','PRODUCT_NOT_ALLOWED');
  elsif v_policy.license_scope='helix_suite' and not exists(
    select 1 from public.helix_ea_products p where p.ea_product_id=v_pair.ea_product_id and p.all_access_eligible
  ) then
    return jsonb_build_object('ok',false,'error_code','PRODUCT_NOT_ALLOWED');
  elsif v_policy.license_scope not in ('product','helix_suite') then
    return jsonb_build_object('ok',false,'error_code','LICENSE_POLICY_INVALID');
  end if;
  if v_license.status<>'active' then return jsonb_build_object('ok',false,'error_code',case v_license.status when 'suspended' then 'LICENSE_SUSPENDED' when 'revoked' then 'LICENSE_REVOKED' else 'LICENSE_NOT_ACTIVE' end); end if;
  if v_license.deleted_at is not null or (v_license.expires_at is not null and v_license.expires_at<=v_now) then return jsonb_build_object('ok',false,'error_code','LICENSE_EXPIRED'); end if;

  -- Validate the binding-wide magic invariant before any mutation. Returning a
  -- JSON error after writes would otherwise commit a half-approved pairing.
  if v_pair.magic_base is not null and exists(
    select 1 from public.helix_license_bindings b
    left join public.helix_license_sessions s on s.binding_id=b.id and s.revoked_at is null
    where b.license_id=v_license.id and b.account_fingerprint=v_pair.account_fingerprint
      and ((b.magic_base is not null and b.magic_base<>v_pair.magic_base)
        or (s.magic_base is not null and s.magic_base<>v_pair.magic_base))
  ) then return jsonb_build_object('ok',false,'error_code','MAGIC_BASE_CONFLICT'); end if;

  select * into v_binding from public.helix_license_bindings
   where license_id=v_license.id and account_fingerprint=v_pair.account_fingerprint for update;
  v_binding_exists:=found;
  if v_binding_exists and v_binding.release_state='pending_release' then
    return jsonb_build_object('ok',false,'error_code','BINDING_PENDING_RELEASE');
  end if;

  select count(distinct l.member_id),min(l.member_id::text)::uuid into v_legacy_members,v_legacy_owner
    from public.helix_license_bindings b join public.helix_licenses l on l.id=b.license_id
   where b.account_fingerprint=v_pair.account_fingerprint and b.released_at is null;
  if v_legacy_members>1 or (v_legacy_members=1 and v_legacy_owner<>p_member_id) then
    return jsonb_build_object('ok',false,'error_code','LEGACY_ACCOUNT_OWNER_CONFLICT');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_pair.registry_fingerprint,0));
  if exists(select 1 from public.helix_member_mt5_accounts a where a.registry_fingerprint=v_pair.registry_fingerprint and a.status in ('active','pending_release','suspended','released','quarantined','unreconciled') and a.member_id<>p_member_id) then
    return jsonb_build_object('ok',false,'error_code','ACCOUNT_OWNED_BY_ANOTHER_MEMBER');
  end if;
  if exists(select 1 from public.helix_member_mt5_accounts a where a.normalized_server=v_pair.normalized_server and a.account_login=v_pair.account_login and a.status in ('active','pending_release','suspended','quarantined','unreconciled') and a.member_id<>p_member_id) then
    return jsonb_build_object('ok',false,'error_code','LEGACY_ACCOUNT_OWNER_CONFLICT');
  end if;
  select * into v_account from public.helix_member_mt5_accounts
   where registry_fingerprint=v_pair.registry_fingerprint and member_id=p_member_id order by (status='released'),created_at desc limit 1 for update;
  if found then
    if v_account.member_id<>p_member_id then return jsonb_build_object('ok',false,'error_code','ACCOUNT_OWNED_BY_ANOTHER_MEMBER'); end if;
    if v_account.status in ('pending_release','suspended','quarantined','unreconciled') then return jsonb_build_object('ok',false,'error_code','ACCOUNT_NOT_RECLAIMABLE'); end if;
    if v_account.status='released' and exists(select 1 from public.helix_license_bindings b where b.member_mt5_account_id=v_account.id and (b.released_at is null or b.release_state<>'released')) then return jsonb_build_object('ok',false,'error_code','ACCOUNT_RELEASE_INCOMPLETE'); end if;
    if v_account.status='released' then
      select mt5_slot_capacity into v_capacity from public.helix_members where id=p_member_id;
      select count(*) into v_used from public.helix_member_mt5_accounts where member_id=p_member_id and status in ('active','pending_release','suspended','quarantined','unreconciled');
      if coalesce(v_capacity,0)<5 or v_used>=v_capacity then return jsonb_build_object('ok',false,'error_code','MEMBER_SLOT_LIMIT_REACHED','used',v_used,'capacity',v_capacity); end if;
      update public.helix_member_mt5_accounts set status='active',released_at=null,updated_at=v_now where id=v_account.id returning * into v_account;
      v_needs_slot:=true;
    end if;
    v_existing_account:=true;
    v_needs_slot:=false;
  else
    -- A migration-created legacy row is reconciled only after a live OTP proves
    -- the same normalized server/login and the owner is unambiguous. Its HMAC is
    -- generated server-side by the authenticated portal, never by the EA.
    select * into v_account from public.helix_member_mt5_accounts
     where member_id=p_member_id and normalized_server=v_pair.normalized_server
       and account_login=v_pair.account_login and fingerprint_version=0 and status='unreconciled'
     for update;
    if found then
      update public.helix_member_mt5_accounts set registry_fingerprint=v_pair.registry_fingerprint,
        fingerprint_version=1,status='active',released_at=null,updated_at=v_now
       where id=v_account.id returning * into v_account;
      v_existing_account:=true;
      v_needs_slot:=false;
    else
    -- A released row may be reclaimed by the same member only after every
    -- binding's existing release ACK completed; reclaiming reserves a slot again.
    select * into v_account from public.helix_member_mt5_accounts
     where registry_fingerprint=v_pair.registry_fingerprint and member_id=p_member_id and status='released' for update;
    if found then
      if exists(select 1 from public.helix_license_bindings b where b.member_mt5_account_id=v_account.id and (b.released_at is null or b.release_state<>'released')) then
        return jsonb_build_object('ok',false,'error_code','ACCOUNT_RELEASE_INCOMPLETE');
      end if;
      select mt5_slot_capacity into v_capacity from public.helix_members where id=p_member_id;
      select count(*) into v_used from public.helix_member_mt5_accounts where member_id=p_member_id and status in ('active','pending_release','suspended','quarantined','unreconciled');
      select (setting_value #>> '{}')::integer into v_max_slots from public.helix_general_settings where setting_key='mt5_member_slot_max';
      if v_max_slots is null or v_capacity is null or v_capacity<5 or v_capacity>v_max_slots or v_used>=v_capacity then
        return jsonb_build_object('ok',false,'error_code','MEMBER_SLOT_LIMIT_REACHED','used',v_used,'capacity',v_capacity);
      end if;
      update public.helix_member_mt5_accounts set status='active',released_at=null,updated_at=v_now where id=v_account.id returning * into v_account;
      v_existing_account:=true;
      v_needs_slot:=true;
    else
      select mt5_slot_capacity into v_capacity from public.helix_members where id=p_member_id;
      if coalesce(v_capacity,0)<5 then return jsonb_build_object('ok',false,'error_code','SLOT_CAPACITY_NOT_CONFIGURED'); end if;
      select count(*) into v_used from public.helix_member_mt5_accounts where member_id=p_member_id and status in ('active','pending_release','suspended','quarantined','unreconciled');
      -- Unmigrated legacy bindings are counted as one slot if their SHA-256
      -- fingerprint matches this request and their license owner is unambiguous.
      if v_legacy_members=1 then
        if exists(select 1 from public.helix_member_mt5_accounts a where a.member_id=p_member_id and a.registry_fingerprint=v_pair.registry_fingerprint) then v_needs_slot:=false;
        else v_used:=v_used+1; end if;
      elsif exists(select 1 from public.helix_member_mt5_accounts a where a.member_id=p_member_id and a.normalized_server=v_pair.normalized_server and a.account_login=v_pair.account_login and a.status in ('active','pending_release','suspended','quarantined','unreconciled')) then
        return jsonb_build_object('ok',false,'error_code','REGISTRY_FINGERPRINT_CONFLICT');
      end if;
      select (setting_value #>> '{}')::integer into v_max_slots from public.helix_general_settings where setting_key='mt5_member_slot_max';
      if v_max_slots is null or v_max_slots<5 or v_max_slots%5<>0 then return jsonb_build_object('ok',false,'error_code','SLOT_LIMIT_CONFIG_INVALID'); end if;
      if v_capacity>v_max_slots then return jsonb_build_object('ok',false,'error_code','MEMBER_CAPACITY_ABOVE_CONFIGURED_MAX'); end if;
      if v_needs_slot and v_used >= v_capacity then return jsonb_build_object('ok',false,'error_code','MEMBER_SLOT_LIMIT_REACHED','used',v_used,'capacity',v_capacity); end if;
      insert into public.helix_member_mt5_accounts(member_id,registry_fingerprint,fingerprint_version,broker_server,normalized_server,account_login,mode,status)
      values(p_member_id,v_pair.registry_fingerprint,1,v_pair.broker_server,v_pair.normalized_server,v_pair.account_login,v_pair.mode,'active') returning * into v_account;
    end if;
    end if;
  end if;

  if v_legacy_members=1 then
    update public.helix_license_bindings b set member_mt5_account_id=v_account.id
     from public.helix_licenses l where l.id=b.license_id and l.member_id=p_member_id and b.account_fingerprint=v_pair.account_fingerprint and b.member_mt5_account_id is null;
  end if;
  if not v_binding_exists then
    insert into public.helix_license_bindings(license_id,broker_server,account_login,account_fingerprint,mode,member_mt5_account_id)
    values(v_license.id,v_pair.broker_server,v_pair.account_login,v_pair.account_fingerprint,v_pair.mode,v_account.id) returning * into v_binding;
  else
    if v_binding.release_state='pending_release' then return jsonb_build_object('ok',false,'error_code','BINDING_PENDING_RELEASE'); end if;
    if v_binding.released_at is not null then
      update public.helix_license_sessions set revoked_at=coalesce(revoked_at,v_now),revoke_reason=coalesce(revoke_reason,'binding_released') where binding_id=v_binding.id;
      v_reactivated:=true;
    end if;
    update public.helix_license_bindings set broker_server=v_pair.broker_server,account_login=v_pair.account_login,mode=v_pair.mode,last_sync_at=v_now,released_at=null,member_mt5_account_id=v_account.id where id=v_binding.id returning * into v_binding;
  end if;
  if v_license.activation_policy='first_activation' and v_license.first_activated_at is null then
    update public.helix_licenses set first_activated_at=v_now,issued_at=coalesce(issued_at,v_now),expires_at=v_now+make_interval(days=>coalesce(duration_days,730)),entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id returning * into v_license;
    v_activated:=true;
  else update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id returning * into v_license; end if;
  update public.helix_pairing_requests set state='approved',member_id=p_member_id,license_id=v_license.id,binding_id=v_binding.id,approved_at=v_now where id=v_pair.id;
  insert into public.helix_license_sessions(pairing_request_id,license_id,binding_id,session_secret_hash,ea_product_id,ea_version,is_canary,expires_at)
  values(v_pair.id,v_license.id,v_binding.id,v_pair.session_secret_hash,v_pair.ea_product_id,v_pair.ea_version,p_canary,least(v_now+interval '365 days',coalesce(v_license.expires_at,v_now+interval '365 days'))) on conflict(pairing_request_id) do nothing;
  if v_pair.magic_base is not null then
    update public.helix_license_sessions set magic_base=v_pair.magic_base where pairing_request_id=v_pair.id and magic_base is null;
    update public.helix_license_bindings set magic_base=v_pair.magic_base where id=v_binding.id and magic_base is null;
  end if;
  insert into public.helix_member_slot_events(member_id,actor_id,event_type,capacity_delta,capacity_before,capacity_after,member_mt5_account_id,idempotency_key,reason,metadata)
  select p_member_id,p_actor_id,'account_claimed',0,m.mt5_slot_capacity,m.mt5_slot_capacity,v_account.id,v_pair.id,'OTP pairing account claim',jsonb_build_object('ea_product_id',v_pair.ea_product_id,'binding_id',v_binding.id)
    from public.helix_members m where m.id=p_member_id on conflict(idempotency_key) do nothing;
  insert into public.helix_license_events(license_id,actor_id,event_type,binding_id,metadata)
  values(v_license.id,p_actor_id,case when v_activated then 'activated'::public.helix_event_type else 'sync'::public.helix_event_type end,v_binding.id,jsonb_build_object('source','otp_pairing_universal_slots','binding_reactivated',v_reactivated,'ea_product_id',v_pair.ea_product_id,'member_mt5_account_id',v_account.id));
  return jsonb_build_object('ok',true,'state','APPROVED','binding_id',v_binding.id,'license_id',v_license.id,'member_mt5_account_id',v_account.id,'entitlement_version',v_license.entitlement_version,'member_slot_capacity',(select mt5_slot_capacity from public.helix_members where id=p_member_id));
end $$;
revoke all on function public.helix_pairing_approve_universal(text,uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.helix_pairing_approve_universal(text,uuid,uuid,uuid,boolean) to service_role;

create or replace function public.helix_sync_member_mt5_account_release()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_status text;
begin
  v_id:=coalesce(new.member_mt5_account_id,old.member_mt5_account_id);
  if v_id is null then return new; end if;
  if exists(select 1 from public.helix_license_bindings b where b.member_mt5_account_id=v_id and b.released_at is null and b.release_state='pending_release') then v_status:='pending_release';
  elsif exists(select 1 from public.helix_license_bindings b where b.member_mt5_account_id=v_id and (b.released_at is null or b.release_state<>'released')) then v_status:='active';
  else v_status:='released'; end if;
  update public.helix_member_mt5_accounts set status=v_status,released_at=case when v_status='released' then coalesce(released_at,now()) else null end,updated_at=now() where id=v_id;
  return new;
end $$;
revoke all on function public.helix_sync_member_mt5_account_release() from public,anon,authenticated,service_role;
drop trigger if exists helix_sync_member_mt5_account_release on public.helix_license_bindings;
create trigger helix_sync_member_mt5_account_release after update of released_at,release_state on public.helix_license_bindings
for each row execute function public.helix_sync_member_mt5_account_release();

create or replace function public.helix_request_mt5_account_release(p_member_id uuid,p_account_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_account public.helix_member_mt5_accounts; v_binding public.helix_license_bindings; v_result jsonb; v_releases jsonb:='[]'::jsonb; v_pending integer:=0;
begin
  if length(trim(coalesce(p_reason,''))) not between 3 and 300 then return jsonb_build_object('ok',false,'error_code','REASON_REQUIRED'); end if;
  if p_actor_id is distinct from p_member_id and not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','NOT_AUTHORIZED'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text,0));
  select * into v_account from public.helix_member_mt5_accounts where id=p_account_id and member_id=p_member_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','NOT_OWNER'); end if;
  if v_account.status='released' then return jsonb_build_object('ok',true,'state','RELEASED','idempotent',true,'slot_retained',false); end if;
  for v_binding in select b.* from public.helix_license_bindings b where b.member_mt5_account_id=v_account.id and b.released_at is null order by b.id for update loop
    if v_binding.release_state='active' then
      v_result:=public.helix_request_binding_release_v18k(p_member_id,v_binding.id,p_actor_id,left(trim(p_reason),300));
      if not coalesce((v_result->>'ok')::boolean,false) then return v_result; end if;
      v_releases:=v_releases||jsonb_build_array(v_result);
      v_pending:=v_pending+1;
    elsif v_binding.release_state='pending_release' then
      v_pending:=v_pending+1;
      v_releases:=v_releases||jsonb_build_array(jsonb_build_object('state','PENDING_RELEASE','release_id',v_binding.release_request_id,'binding_id',v_binding.id));
    end if;
  end loop;
  if v_pending>0 then
    update public.helix_member_mt5_accounts set status='pending_release',updated_at=now() where id=v_account.id;
  else
    update public.helix_member_mt5_accounts set status='released',released_at=coalesce(released_at,now()),updated_at=now() where id=v_account.id;
  end if;
  return jsonb_build_object('ok',true,'state',case when v_pending>0 then 'PENDING_RELEASE' else 'RELEASED' end,'member_mt5_account_id',v_account.id,'pending_bindings',v_pending,'releases',v_releases,'slot_retained',v_pending>0);
end $$;
revoke all on function public.helix_request_mt5_account_release(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.helix_request_mt5_account_release(uuid,uuid,uuid,text) to service_role;

create or replace function public.helix_admin_adjust_member_slots(
  p_member_id uuid,p_actor_id uuid,p_delta integer,p_idempotency_key uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_member public.helix_members; v_before integer; v_after integer; v_max integer; v_existing public.helix_member_slot_events;
begin
  if p_idempotency_key is null or p_delta is null or p_delta=0 or p_delta%5<>0
     or length(trim(coalesce(p_reason,''))) not between 3 and 300 then
    return jsonb_build_object('ok',false,'error_code','INVALID_SLOT_ADJUSTMENT');
  end if;
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then
    return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  select * into v_existing from public.helix_member_slot_events where idempotency_key=p_idempotency_key;
  if found then
    if v_existing.member_id<>p_member_id or v_existing.capacity_delta<>p_delta or v_existing.reason<>left(trim(p_reason),300) then
      return jsonb_build_object('ok',false,'error_code','IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('ok',true,'idempotent',true,'capacity',v_existing.capacity_after);
  end if;
  select * into v_member from public.helix_members where id=p_member_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','MEMBER_NOT_FOUND'); end if;
  select (setting_value #>> '{}')::integer into v_max from public.helix_general_settings where setting_key='mt5_member_slot_max';
  if v_max is null or v_max<5 or v_max%5<>0 then return jsonb_build_object('ok',false,'error_code','SLOT_LIMIT_CONFIG_INVALID'); end if;
  v_before:=v_member.mt5_slot_capacity; v_after:=v_before+p_delta;
  if v_after<0 or v_after>v_max then return jsonb_build_object('ok',false,'error_code','SLOT_CAPACITY_OUT_OF_RANGE','maximum',v_max); end if;
  if v_after < (select count(*) from public.helix_member_mt5_accounts a where a.member_id=p_member_id and a.status in ('active','pending_release','suspended','quarantined','unreconciled')) then
    return jsonb_build_object('ok',false,'error_code','SLOT_CAPACITY_BELOW_USAGE');
  end if;
  update public.helix_members set mt5_slot_capacity=v_after,updated_at=now() where id=p_member_id;
  insert into public.helix_member_slot_events(member_id,actor_id,event_type,capacity_delta,capacity_before,capacity_after,idempotency_key,reason)
  values(p_member_id,p_actor_id,'capacity_adjusted',p_delta,v_before,v_after,p_idempotency_key,left(trim(p_reason),300));
  insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
  select l.id,p_actor_id,'sync',jsonb_build_object('action','member_slot_capacity_adjusted','capacity_before',v_before,'capacity_after',v_after,'reason',left(trim(p_reason),300))
  from public.helix_licenses l where l.member_id=p_member_id and l.deleted_at is null order by l.created_at desc limit 1;
  return jsonb_build_object('ok',true,'idempotent',false,'capacity',v_after);
end $$;
revoke all on function public.helix_admin_adjust_member_slots(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.helix_admin_adjust_member_slots(uuid,uuid,integer,uuid,text) to service_role;

-- Idempotent first-license package grant. The member row lock serializes two
-- simultaneous first purchases so both cannot independently add +5.
create or replace function public.helix_admin_ensure_member_initial_slots(
  p_member_id uuid,p_actor_id uuid,p_idempotency_key uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_member public.helix_members; v_existing public.helix_member_slot_events; v_max integer;
begin
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then
    return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED');
  end if;
  if p_idempotency_key is null or length(trim(coalesce(p_reason,''))) not between 3 and 300 then
    return jsonb_build_object('ok',false,'error_code','INVALID_SLOT_ADJUSTMENT');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  select * into v_existing from public.helix_member_slot_events where idempotency_key=p_idempotency_key;
  if found then
    if v_existing.member_id<>p_member_id or v_existing.capacity_delta<>5 or v_existing.reason<>left(trim(p_reason),300) then
      return jsonb_build_object('ok',false,'error_code','IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('ok',true,'idempotent',true,'granted',true,'capacity',v_existing.capacity_after);
  end if;
  select * into v_member from public.helix_members where id=p_member_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','MEMBER_NOT_FOUND'); end if;
  select (setting_value #>> '{}')::integer into v_max from public.helix_general_settings where setting_key='mt5_member_slot_max';
  if v_max is null or v_max<5 or v_max%5<>0 then return jsonb_build_object('ok',false,'error_code','SLOT_LIMIT_CONFIG_INVALID'); end if;
  if v_member.mt5_slot_capacity>0 then
    return jsonb_build_object('ok',true,'idempotent',true,'capacity',v_member.mt5_slot_capacity,'granted',false);
  end if;
  update public.helix_members set mt5_slot_capacity=5,updated_at=now() where id=p_member_id;
  insert into public.helix_member_slot_events(member_id,actor_id,event_type,capacity_delta,capacity_before,capacity_after,idempotency_key,reason)
  values(p_member_id,p_actor_id,'capacity_adjusted',5,0,5,p_idempotency_key,left(trim(p_reason),300));
  insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
  select l.id,p_actor_id,'sync',jsonb_build_object('action','initial_member_slot_package','capacity_before',0,'capacity_after',5,'reason',left(trim(p_reason),300))
  from public.helix_licenses l where l.member_id=p_member_id and l.deleted_at is null order by l.created_at desc limit 1;
  return jsonb_build_object('ok',true,'idempotent',false,'capacity',5,'granted',true);
end $$;
revoke all on function public.helix_admin_ensure_member_initial_slots(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.helix_admin_ensure_member_initial_slots(uuid,uuid,uuid,text) to service_role;

-- Email-change handoff copies the complete member-wide capacity exactly once.
-- It never copies account ownership/bindings; those require release ACK first.
create or replace function public.helix_admin_transfer_member_slots(
  p_source_member_id uuid,p_target_member_id uuid,p_actor_id uuid,p_request_id uuid,p_idempotency_key uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_source public.helix_members; v_target public.helix_members; v_existing public.helix_member_slot_events; v_max integer; v_after integer; v_reason text;
begin
  v_reason:=left(trim(coalesce(p_reason,'')),300);
  if p_source_member_id is null or p_target_member_id is null or p_source_member_id=p_target_member_id
     or p_request_id is null or p_idempotency_key is null or length(v_reason) not between 3 and 300 then
    return jsonb_build_object('ok',false,'error_code','INVALID_SLOT_TRANSFER');
  end if;
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then
    return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  select * into v_existing from public.helix_member_slot_events where idempotency_key=p_idempotency_key;
  if found then
    if v_existing.member_id<>p_target_member_id or v_existing.event_type<>'capacity_adjusted'
       or v_existing.metadata->>'action'<>'email_change_capacity_transfer'
       or v_existing.metadata->>'source_member_id'<>p_source_member_id::text
       or v_existing.metadata->>'request_id'<>p_request_id::text then
      return jsonb_build_object('ok',false,'error_code','IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('ok',true,'idempotent',true,'capacity',v_existing.capacity_after);
  end if;
  perform 1 from public.helix_members where id in (p_source_member_id,p_target_member_id) order by id for update;
  select * into v_source from public.helix_members where id=p_source_member_id;
  select * into v_target from public.helix_members where id=p_target_member_id;
  if v_source.id is null or v_target.id is null then return jsonb_build_object('ok',false,'error_code','MEMBER_NOT_FOUND'); end if;
  select (setting_value #>> '{}')::integer into v_max from public.helix_general_settings where setting_key='mt5_member_slot_max';
  if v_max is null or v_max<5 or v_max%5<>0 or v_source.mt5_slot_capacity>v_max then return jsonb_build_object('ok',false,'error_code','SLOT_LIMIT_CONFIG_INVALID'); end if;
  if v_target.mt5_slot_capacity not in (0,v_source.mt5_slot_capacity) then return jsonb_build_object('ok',false,'error_code','TARGET_CAPACITY_NOT_EMPTY'); end if;
  if exists(select 1 from public.helix_member_mt5_accounts where member_id=p_target_member_id and status in ('active','pending_release','suspended','quarantined','unreconciled')) then
    return jsonb_build_object('ok',false,'error_code','TARGET_ALREADY_OWNS_MT5_ACCOUNTS');
  end if;
  v_after:=v_source.mt5_slot_capacity;
  update public.helix_members set mt5_slot_capacity=v_after,updated_at=now() where id=p_target_member_id;
  insert into public.helix_member_slot_events(member_id,actor_id,event_type,capacity_delta,capacity_before,capacity_after,idempotency_key,reason,metadata)
  values(p_target_member_id,p_actor_id,'capacity_adjusted',v_after-v_target.mt5_slot_capacity,v_target.mt5_slot_capacity,v_after,p_idempotency_key,v_reason,
    jsonb_build_object('action','email_change_capacity_transfer','source_member_id',p_source_member_id,'request_id',p_request_id));
  insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
  select l.id,p_actor_id,'sync',jsonb_build_object('action','email_change_capacity_transferred','source_member_id',p_source_member_id,'request_id',p_request_id,'capacity',v_after)
    from public.helix_licenses l where l.member_id=p_target_member_id and l.deleted_at is null order by l.created_at desc limit 1;
  return jsonb_build_object('ok',true,'idempotent',false,'capacity',v_after,'source_member_id',p_source_member_id,'target_member_id',p_target_member_id);
end $$;
revoke all on function public.helix_admin_transfer_member_slots(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.helix_admin_transfer_member_slots(uuid,uuid,uuid,uuid,uuid,text) to service_role;

create or replace function public.helix_admin_preserve_email_change_expiry(
  p_source_license_id uuid,p_target_license_id uuid,p_actor_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_source public.helix_licenses; v_target public.helix_licenses; v_request public.helix_email_change_requests;
begin
  if p_source_license_id is null or p_target_license_id is null or p_source_license_id=p_target_license_id or p_request_id is null
     or not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then
    return jsonb_build_object('ok',false,'error_code','INVALID_EXPIRY_HANDOFF');
  end if;
  perform 1 from public.helix_licenses where id in (p_source_license_id,p_target_license_id) order by id for update;
  select * into v_source from public.helix_licenses where id=p_source_license_id;
  select * into v_target from public.helix_licenses where id=p_target_license_id;
  select * into v_request from public.helix_email_change_requests where id=p_request_id for share;
  if v_source.id is null or v_target.id is null or v_request.id is null
     or v_source.member_id<>v_request.member_id or v_target.member_id=v_request.member_id
     or v_request.status<>'pending' or v_request.expires_at<=now()
     or v_target.status<>'active' or v_target.deleted_at is not null then
    return jsonb_build_object('ok',false,'error_code','EXPIRY_HANDOFF_OWNERSHIP_INVALID');
  end if;
  if exists(select 1 from public.helix_license_events e where e.license_id=v_target.id
      and e.metadata->>'action'='email_change_expiry_preserved'
      and e.metadata->>'request_id'=p_request_id::text and e.metadata->>'source_license_id'=p_source_license_id::text) then
    return jsonb_build_object('ok',true,'idempotent',true,'expires_at',v_source.expires_at);
  end if;
  update public.helix_licenses set expires_at=v_source.expires_at,activation_policy='legacy_fixed',
    first_activated_at=coalesce(v_source.first_activated_at,v_source.issued_at),duration_days=v_source.duration_days,
    entitlement_version=entitlement_version+1,updated_at=now() where id=v_target.id returning * into v_target;
  insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
  values(v_target.id,p_actor_id,'sync',jsonb_build_object('action','email_change_expiry_preserved','request_id',p_request_id,
    'source_license_id',v_source.id,'source_member_id',v_source.member_id,'expires_at',v_source.expires_at));
  return jsonb_build_object('ok',true,'idempotent',false,'expires_at',v_target.expires_at,'activation_policy',v_target.activation_policy);
end $$;
revoke all on function public.helix_admin_preserve_email_change_expiry(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.helix_admin_preserve_email_change_expiry(uuid,uuid,uuid,uuid) to service_role;

create or replace function public.helix_admin_set_license_product_policy(
  p_license_id uuid,p_actor_id uuid,p_package text,p_allowed_products text[],p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_license public.helix_licenses; v_products text[]; v_expected text[];
begin
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED'); end if;
  if p_package not in ('dedicated','bundle','all') or length(trim(coalesce(p_reason,''))) not between 3 and 300 then return jsonb_build_object('ok',false,'error_code','INVALID_POLICY'); end if;
  select * into v_license from public.helix_licenses where id=p_license_id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok',false,'error_code','LICENSE_NOT_FOUND'); end if;
  select coalesce(array_agg(distinct x order by x),array[]::text[]) into v_products from unnest(coalesce(p_allowed_products,array[]::text[])) x;
  if cardinality(v_products)=0 or exists(select 1 from unnest(v_products) x left join public.helix_ea_products p on p.ea_product_id=x where p.ea_product_id is null or not p.enabled or p.catalog_status<>'published' or (p_package='all' and not p.all_access_eligible)) then
    return jsonb_build_object('ok',false,'error_code','PRODUCT_NOT_PUBLISHED');
  end if;
  if (p_package='dedicated' and cardinality(v_products)<>1) or (p_package='bundle' and cardinality(v_products)<2) then return jsonb_build_object('ok',false,'error_code','PACKAGE_PRODUCT_COUNT_INVALID'); end if;
  if p_package='all' then
    select coalesce(array_agg(ea_product_id order by ea_product_id),array[]::text[]) into v_expected from public.helix_ea_products where enabled and catalog_status='published' and all_access_eligible;
    if v_products is distinct from v_expected then return jsonb_build_object('ok',false,'error_code','ALL_SCOPE_MUST_MATCH_ELIGIBLE_CATALOG'); end if;
  end if;
  insert into public.helix_license_product_policies(license_id,license_scope,allowed_products,license_package,updated_at)
  values(p_license_id,'product',v_products,p_package,now())
  on conflict(license_id) do update set license_scope='product',allowed_products=excluded.allowed_products,license_package=excluded.license_package,updated_at=now();
  update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=now() where id=p_license_id returning * into v_license;
  insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
  values(p_license_id,p_actor_id,'sync',jsonb_build_object('action','license_product_policy_changed','package',p_package,'allowed_products',v_products,'reason',left(trim(p_reason),300)));
  return jsonb_build_object('ok',true,'license_id',p_license_id,'license_package',p_package,'allowed_products',to_jsonb(v_products),'entitlement_version',v_license.entitlement_version);
end $$;
revoke all on function public.helix_admin_set_license_product_policy(uuid,uuid,text,text[],text) from public,anon,authenticated;
grant execute on function public.helix_admin_set_license_product_policy(uuid,uuid,text,text[],text) to service_role;

alter table public.helix_member_mt5_accounts enable row level security;
alter table public.helix_member_slot_events enable row level security;
alter table public.helix_product_events enable row level security;
revoke all on public.helix_member_mt5_accounts,public.helix_member_slot_events from anon,authenticated;
revoke all on public.helix_product_events from anon,authenticated;
grant select,insert,update,delete on public.helix_member_mt5_accounts,public.helix_member_slot_events to service_role;
grant select,insert,update,delete on public.helix_product_events to service_role;

create or replace function public.helix_admin_set_all_access_product(p_product_id text,p_actor_id uuid,p_include boolean,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_product public.helix_ea_products; v_policy public.helix_license_product_policies; v_next text[]; v_count integer:=0;
begin
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED'); end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 300 then return jsonb_build_object('ok',false,'error_code','REASON_REQUIRED'); end if;
  select * into v_product from public.helix_ea_products where ea_product_id=p_product_id for update;
  if not found or (p_include and (v_product.catalog_status<>'published' or not v_product.enabled)) then return jsonb_build_object('ok',false,'error_code','PRODUCT_NOT_PUBLISHED'); end if;
  for v_policy in select * from public.helix_license_product_policies where license_package='all' order by license_id for update loop
    -- Legacy suite grants intentionally keep allowed_products empty; the
    -- catalog's all_access_eligible flag is their authoritative product set.
    if v_policy.license_scope='product' then
      if p_include then
        select array_agg(distinct x order by x) into v_next from unnest(v_policy.allowed_products||array[p_product_id]) x;
      else
        select coalesce(array_agg(x order by x),array[]::text[]) into v_next from unnest(v_policy.allowed_products) x where x<>p_product_id;
      end if;
      if cardinality(v_next)=0 then return jsonb_build_object('ok',false,'error_code','ALL_PACKAGE_CANNOT_BE_EMPTY'); end if;
      update public.helix_license_product_policies set allowed_products=v_next,updated_at=now() where license_id=v_policy.license_id;
    elsif v_policy.license_scope<>'helix_suite' then
      return jsonb_build_object('ok',false,'error_code','LICENSE_POLICY_INVALID');
    end if;
    update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=now() where id=v_policy.license_id;
    insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
    values(v_policy.license_id,p_actor_id,'sync',jsonb_build_object('action',case when p_include then 'all_access_product_included' else 'all_access_product_excluded' end,'ea_product_id',p_product_id,'reason',left(trim(p_reason),300)));
    v_count:=v_count+1;
  end loop;
  update public.helix_ea_products set all_access_eligible=p_include,updated_at=now() where ea_product_id=p_product_id;
  insert into public.helix_product_events(ea_product_id,actor_id,event_type,reason,metadata)
  values(p_product_id,p_actor_id,case when p_include then 'all_access_included' else 'all_access_excluded' end,left(trim(p_reason),300),jsonb_build_object('affected_all_licenses',v_count));
  return jsonb_build_object('ok',true,'ea_product_id',p_product_id,'included',p_include,'affected_all_licenses',v_count);
end $$;
revoke all on function public.helix_admin_set_all_access_product(text,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.helix_admin_set_all_access_product(text,uuid,boolean,text) to service_role;

-- B. New licenses default to one dedicated product; no implicit suite grant.
-- Existing policies are not changed by this trigger replacement.
create or replace function public.helix_license_default_product_policy()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists (select 1 from public.helix_ea_products p
                  where p.ea_product_id=new.product_slug) then
    raise exception 'PRODUCT_CATALOG_ENTRY_REQUIRED';
  end if;
  insert into public.helix_license_product_policies(license_id,license_scope,allowed_products,license_package)
  values(new.id,'product',array[new.product_slug],'dedicated')
  on conflict(license_id) do nothing;
  return new;
end $$;
revoke all on function public.helix_license_default_product_policy() from public,anon,authenticated,service_role;

-- C. Preserve every released binding that owns telemetry/performance data.
-- This deliberately keeps those binding rows indefinitely, because current
-- facts have NOT NULL binding_id FKs with ON DELETE CASCADE. Empty bindings
-- may still be purged after the existing one-month threshold.
create or replace function public.helix_purge_released_bindings_after_one_month()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_candidates jsonb; v_binding_ids uuid[]; v_deleted integer:=0;
begin
  select jsonb_agg(jsonb_build_object('id',stale.id,'license_id',stale.license_id,'released_at',stale.released_at))
    into v_candidates
  from (
    select b.id,b.license_id,b.released_at
    from public.helix_license_bindings b
    where b.release_state='released'
      and b.released_at < now()-interval '1 month'
      and not exists(select 1 from public.helix_license_sessions s where s.binding_id=b.id and s.revoked_at is null)
      and not exists(select 1 from public.helix_telemetry_deals d where d.binding_id=b.id)
      and not exists(select 1 from public.helix_completed_trades t where t.binding_id=b.id)
    order by b.released_at,b.id limit 500 for update of b skip locked
  ) stale;
  if v_candidates is null or jsonb_array_length(v_candidates)=0 then return 0; end if;
  select array_agg((item->>'id')::uuid) into v_binding_ids from jsonb_array_elements(v_candidates) item;
  update public.helix_license_events set binding_id=null where binding_id=any(v_binding_ids);
  insert into public.helix_license_events(license_id,event_type,metadata)
  select (item->>'license_id')::uuid,'reset',jsonb_build_object(
    'action','released_binding_history_purged_after_one_month','released_at',item->>'released_at')
  from jsonb_array_elements(v_candidates) item;
  delete from public.helix_license_bindings
   where id=any(v_binding_ids) and release_state='released' and released_at < now()-interval '1 month';
  get diagnostics v_deleted=row_count;
  return v_deleted;
end $$;
revoke all on function public.helix_purge_released_bindings_after_one_month() from public,anon,authenticated,service_role;

-- D. Read-only entitlement queries now include released bindings so validated
-- history remains visible to its existing member/license owner. Aggregation,
-- FX conversion and trade values are unchanged.
create or replace function public.helix_member_performance_summary_v2(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('status',case when count(*)=0 then 'NO_DATA' else 'READY' end,
  'by_currency',coalesce(jsonb_agg(jsonb_build_object('currency',q.currency,'trades',q.trades,'wins',q.wins,'losses',q.losses,'break_even',q.break_even,'gross_profit',q.gross_profit,'gross_loss',q.gross_loss,'net_pnl',q.net_pnl,'last_sync_at',q.last_sync_at) order by q.currency),'[]'::jsonb),
  'last_sync_at',max(q.last_sync_at))
 from (select t.currency,count(*)::integer trades,count(*) filter(where t.outcome='win')::integer wins,count(*) filter(where t.outcome='loss')::integer losses,count(*) filter(where t.outcome='break_even')::integer break_even,coalesce(sum(t.net_pnl) filter(where t.net_pnl>0),0) gross_profit,abs(coalesce(sum(t.net_pnl) filter(where t.net_pnl<0),0)) gross_loss,sum(t.net_pnl) net_pnl,(select max(s.last_telemetry_sync_at) from public.helix_license_sessions s where s.binding_id=b.id) last_sync_at
 from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
 where l.member_id=p_member_id and l.deleted_at is null and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id) and (p_from is null or t.closed_at_broker>=greatest(p_from,timestamp '2026-09-01 00:00:00')) and (p_to is null or t.closed_at_broker<p_to)
 group by t.currency,b.id) q;
$$;

create or replace function public.helix_member_performance_daily_v2(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('broker_date',d.broker_date,'currency',d.currency,'net_pnl',d.net_pnl,'trades',d.trades) order by d.broker_date),'[]'::jsonb)
 from (select t.closed_at_broker::date broker_date,t.currency,round(sum(t.net_pnl),8) net_pnl,count(*)::integer trades
 from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
 where l.member_id=p_member_id and l.deleted_at is null and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id) and t.closed_at_broker>=greatest(coalesce(p_from,timestamp '2026-09-01 00:00:00'),timestamp '2026-09-01 00:00:00') and (p_to is null or t.closed_at_broker<p_to)
 group by t.closed_at_broker::date,t.currency) d;
$$;

create or replace function public.helix_member_performance_canary_summary_v2(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('status',case when count(*)=0 then 'NO_DATA' else 'READY' end,
  'by_currency',coalesce(jsonb_agg(jsonb_build_object('currency',q.currency,'trades',q.trades,'wins',q.wins,'losses',q.losses,'break_even',q.break_even,'gross_profit',q.gross_profit,'gross_loss',q.gross_loss,'net_pnl',q.net_pnl,'last_sync_at',q.last_sync_at) order by q.currency),'[]'::jsonb),
  'last_sync_at',max(q.last_sync_at))
 from (select t.currency,count(*)::integer trades,count(*) filter(where t.outcome='win')::integer wins,count(*) filter(where t.outcome='loss')::integer losses,count(*) filter(where t.outcome='break_even')::integer break_even,coalesce(sum(t.net_pnl) filter(where t.net_pnl>0),0) gross_profit,abs(coalesce(sum(t.net_pnl) filter(where t.net_pnl<0),0)) gross_loss,sum(t.net_pnl) net_pnl,(select max(s.last_telemetry_sync_at) from public.helix_license_sessions s where s.binding_id=b.id) last_sync_at
 from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
 where l.member_id=p_member_id and l.deleted_at is null and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id) and (p_from is null or t.closed_at_broker>=greatest(p_from,timestamp '2026-09-01 00:00:00')) and (p_to is null or t.closed_at_broker<p_to) and public.helix_is_telemetry_canary_member(l.member_id)
 group by t.currency,b.id) q;
$$;

create or replace function public.helix_member_performance_canary_daily_v2(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamp without time zone default null,p_to timestamp without time zone default null)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('broker_date',d.broker_date,'currency',d.currency,'net_pnl',d.net_pnl,'trades',d.trades) order by d.broker_date),'[]'::jsonb)
 from (select t.closed_at_broker::date broker_date,t.currency,round(sum(t.net_pnl),8) net_pnl,count(*)::integer trades
 from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
 where l.member_id=p_member_id and l.deleted_at is null and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id) and t.closed_at_broker>=greatest(coalesce(p_from,timestamp '2026-09-01 00:00:00'),timestamp '2026-09-01 00:00:00') and (p_to is null or t.closed_at_broker<p_to) and public.helix_is_telemetry_canary_member(l.member_id)
 group by t.closed_at_broker::date,t.currency) d;
$$;

-- Preserve the existing server-only RPC execution model.
do $$ declare f text; begin
  foreach f in array array[
    'helix_member_performance_summary_v2(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone)',
    'helix_member_performance_daily_v2(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone)',
    'helix_member_performance_canary_summary_v2(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone)',
    'helix_member_performance_canary_daily_v2(uuid,uuid,uuid,timestamp without time zone,timestamp without time zone)'
  ] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;

commit;
