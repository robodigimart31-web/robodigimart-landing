-- HELIX Portal R1 production migration. Additive and preserves existing license/customer data.
begin;

alter table public.helix_licenses
  alter column expires_at drop not null;

alter table public.helix_licenses
  add column if not exists issued_at timestamptz,
  add column if not exists first_activated_at timestamptz,
  add column if not exists duration_days smallint,
  add column if not exists activation_policy text not null default 'legacy_fixed',
  add column if not exists last_successful_sync_at timestamptz,
  add column if not exists activation_memo text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='helix_licenses_activation_policy_check') then
    alter table public.helix_licenses add constraint helix_licenses_activation_policy_check
      check (activation_policy in ('legacy_fixed','first_activation'));
  end if;
  if not exists (select 1 from pg_constraint where conname='helix_licenses_duration_days_check') then
    alter table public.helix_licenses add constraint helix_licenses_duration_days_check
      check (duration_days is null or duration_days between 1 and 3650);
  end if;
end $$;

create table if not exists public.helix_pairing_requests (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  session_secret_hash text not null unique,
  state text not null default 'pending' check (state in ('pending','approved','rejected','consumed','expired')),
  broker_server text not null,
  normalized_server text not null,
  account_login text not null,
  account_fingerprint text not null,
  mode text not null check (mode in ('real','demo')),
  member_id uuid references public.helix_members(id) on delete set null,
  license_id uuid references public.helix_licenses(id) on delete set null,
  binding_id uuid references public.helix_license_bindings(id) on delete set null,
  protocol_version text not null default 'v1',
  ea_build text not null default 'unknown',
  attempts smallint not null default 0 check (attempts between 0 and 20),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists helix_pairing_pending_expiry_idx on public.helix_pairing_requests(expires_at) where state='pending';
create index if not exists helix_pairing_member_idx on public.helix_pairing_requests(member_id,created_at desc);

create table if not exists public.helix_license_sessions (
  id uuid primary key default gen_random_uuid(),
  pairing_request_id uuid not null unique references public.helix_pairing_requests(id) on delete cascade,
  license_id uuid not null references public.helix_licenses(id) on delete cascade,
  binding_id uuid not null references public.helix_license_bindings(id) on delete cascade,
  session_secret_hash text not null unique,
  issued_at timestamptz not null default now(),
  last_seen_at timestamptz,
  last_successful_sync_at timestamptz,
  last_telemetry_sync_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz not null default now()
);
create index if not exists helix_license_sessions_license_idx on public.helix_license_sessions(license_id) where revoked_at is null;
create index if not exists helix_license_sessions_binding_idx on public.helix_license_sessions(binding_id) where revoked_at is null;

create table if not exists public.helix_email_change_requests (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.helix_members(id) on delete cascade,
  old_email text not null,
  new_email text not null,
  status text not null default 'pending' check (status in ('pending','approved_awaiting_verification','completed','rejected','expired')),
  member_note text not null default '',
  admin_note text not null default '',
  admin_actor uuid references auth.users(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days')
);
create unique index if not exists helix_email_change_one_pending_idx on public.helix_email_change_requests(member_id) where status in ('pending','approved_awaiting_verification');
create index if not exists helix_email_change_queue_idx on public.helix_email_change_requests(status,created_at desc);

create table if not exists public.helix_telemetry_deals (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.helix_license_bindings(id) on delete cascade,
  deal_ticket text not null,
  position_id text not null,
  occurred_at timestamptz not null,
  direction text not null check (direction in ('BUY','SELL')),
  entry_kind text not null check (entry_kind in ('IN','OUT','INOUT')),
  volume numeric(24,8) not null check (volume > 0),
  profit numeric(24,8) not null,
  commission numeric(24,8) not null,
  swap numeric(24,8) not null,
  fee numeric(24,8) not null,
  currency text not null check (currency ~ '^[A-Z]{3,6}$'),
  symbol text not null,
  magic bigint not null check (magic >= 0),
  ingested_at timestamptz not null default now(),
  unique(binding_id,deal_ticket)
);
create index if not exists helix_telemetry_position_idx on public.helix_telemetry_deals(binding_id,position_id,occurred_at);
create index if not exists helix_telemetry_time_idx on public.helix_telemetry_deals(binding_id,occurred_at desc);

create table if not exists public.helix_completed_trades (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.helix_license_bindings(id) on delete cascade,
  position_id text not null,
  currency text not null,
  symbol text not null,
  net_pnl numeric(24,8) not null,
  outcome text not null check (outcome in ('win','loss','break_even')),
  family text,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique(binding_id,position_id)
);
create index if not exists helix_completed_trades_binding_time_idx on public.helix_completed_trades(binding_id,closed_at desc);
create index if not exists helix_completed_trades_family_idx on public.helix_completed_trades(binding_id,family,closed_at desc);

-- R7 magic values must be reviewed and explicitly allowlisted after source freeze.
-- Empty by default: no synthetic/guessed trade family is presented as production data.
create table if not exists public.helix_telemetry_magic_allowlist (
  magic bigint primary key check (magic >= 0),
  product_slug text not null default 'quadriga',
  enabled boolean not null default false,
  verified_source text not null default '',
  verified_at timestamptz,
  verified_by uuid references auth.users(id)
);

create table if not exists public.helix_api_rate_limits (
  bucket text not null check (bucket ~ '^[a-z_]{2,40}$'),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  blocked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key(bucket,subject_hash)
);
create index if not exists helix_api_rate_limits_cleanup_idx on public.helix_api_rate_limits(updated_at);

create table if not exists public.helix_admin_license_requests (
  idempotency_key uuid primary key,
  actor_id uuid not null references auth.users(id),
  member_id uuid not null references public.helix_members(id),
  license_id uuid not null unique references public.helix_licenses(id),
  created_at timestamptz not null default now()
);

alter table public.helix_pairing_requests enable row level security;
alter table public.helix_license_sessions enable row level security;
alter table public.helix_email_change_requests enable row level security;
alter table public.helix_telemetry_deals enable row level security;
alter table public.helix_completed_trades enable row level security;
alter table public.helix_telemetry_magic_allowlist enable row level security;
alter table public.helix_api_rate_limits enable row level security;
alter table public.helix_admin_license_requests enable row level security;
revoke all on public.helix_pairing_requests,public.helix_license_sessions,public.helix_email_change_requests,public.helix_telemetry_deals,public.helix_completed_trades from anon,authenticated;
revoke all on public.helix_telemetry_magic_allowlist from anon,authenticated;
revoke all on public.helix_api_rate_limits from anon,authenticated;
revoke all on public.helix_admin_license_requests from anon,authenticated;

create or replace function public.helix_rate_limit(p_bucket text,p_subject_hash text,p_limit integer,p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_now timestamptz:=now();v_row public.helix_api_rate_limits;v_allowed boolean;
begin
  if p_bucket !~ '^[a-z_]{2,40}$' or p_subject_hash !~ '^[0-9a-f]{64}$' or p_limit not between 1 and 1000 or p_window_seconds not between 1 and 86400 then
    return jsonb_build_object('allowed',false,'retry_after_seconds',60);
  end if;
  insert into public.helix_api_rate_limits(bucket,subject_hash,window_started_at,request_count,blocked_until,updated_at)
    values(p_bucket,p_subject_hash,v_now,1,null,v_now)
  on conflict(bucket,subject_hash) do update set
    window_started_at=case when public.helix_api_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=v_now then v_now else public.helix_api_rate_limits.window_started_at end,
    request_count=case when public.helix_api_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=v_now then 1 else public.helix_api_rate_limits.request_count+1 end,
    blocked_until=case when public.helix_api_rate_limits.window_started_at+make_interval(secs=>p_window_seconds)<=v_now then null else public.helix_api_rate_limits.blocked_until end,
    updated_at=v_now
  returning * into v_row;
  v_allowed:=v_row.blocked_until is null and v_row.request_count<=p_limit;
  if not v_allowed and v_row.blocked_until is null then
    update public.helix_api_rate_limits set blocked_until=v_now+make_interval(secs=>p_window_seconds) where bucket=p_bucket and subject_hash=p_subject_hash returning * into v_row;
  end if;
  return jsonb_build_object('allowed',v_allowed,'retry_after_seconds',case when v_row.blocked_until is null then 0 else greatest(1,ceil(extract(epoch from v_row.blocked_until-v_now))::integer) end);
end $$;

drop policy if exists member_read_own_email_change_requests on public.helix_email_change_requests;
create policy member_read_own_email_change_requests on public.helix_email_change_requests for select to authenticated
  using (member_id=auth.uid() or public.helix_is_admin());
drop policy if exists member_read_own_completed_trades on public.helix_completed_trades;
create policy member_read_own_completed_trades on public.helix_completed_trades for select to authenticated
  using (exists(select 1 from public.helix_license_bindings b join public.helix_licenses l on l.id=b.license_id where b.id=binding_id and l.member_id=auth.uid()) or public.helix_is_admin());

create or replace function public.helix_pairing_start(
  p_code_hash text,p_session_hash text,p_broker_server text,p_normalized_server text,
  p_account_login text,p_account_fingerprint text,p_mode text,p_protocol_version text,p_ea_build text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_expires timestamptz;
begin
  if length(p_code_hash)<>64 or length(p_session_hash)<>64 or length(p_account_fingerprint)<>64
     or p_mode not in ('real','demo') or length(trim(p_broker_server)) not between 2 and 120
     or p_account_login !~ '^[0-9]{3,18}$' then raise exception 'INVALID_REQUEST'; end if;
  insert into public.helix_pairing_requests(code_hash,session_secret_hash,broker_server,normalized_server,account_login,account_fingerprint,mode,protocol_version,ea_build)
  values(p_code_hash,p_session_hash,trim(p_broker_server),lower(trim(p_normalized_server)),trim(p_account_login),p_account_fingerprint,p_mode,left(p_protocol_version,24),left(p_ea_build,48))
  returning id,expires_at into v_id,v_expires;
  return jsonb_build_object('id',v_id,'expires_at',v_expires);
end $$;

create or replace function public.helix_admin_create_license(p_member_id uuid,p_actor_id uuid,p_product_slug text,p_legacy_hash text,p_duration_days integer,p_max_accounts integer,p_idempotency_key uuid,p_memo text default '')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_license public.helix_licenses;v_request public.helix_admin_license_requests;
begin
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED'); end if;
  if not exists(select 1 from public.helix_members where id=p_member_id and role='member') then return jsonb_build_object('ok',false,'error_code','MEMBER_NOT_FOUND'); end if;
  if p_idempotency_key is null or length(coalesce(p_legacy_hash,''))<>64 or p_product_slug !~ '^[a-z0-9_-]{2,40}$' or p_duration_days not between 1 and 3650 or p_max_accounts not between 1 and 5 then
    return jsonb_build_object('ok',false,'error_code','INVALID_LICENSE');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  select * into v_request from public.helix_admin_license_requests where idempotency_key=p_idempotency_key for update;
  if found then
    if v_request.actor_id<>p_actor_id or v_request.member_id<>p_member_id then return jsonb_build_object('ok',false,'error_code','IDEMPOTENCY_KEY_REUSED'); end if;
    select * into v_license from public.helix_licenses where id=v_request.license_id;
    return jsonb_build_object('ok',true,'idempotent',true,'license',jsonb_build_object('id',v_license.id,'member_id',v_license.member_id,'product_slug',v_license.product_slug,'license_key_hint',v_license.license_key_hint,'status',v_license.status,'expires_at',v_license.expires_at,'max_accounts',v_license.max_accounts,'created_at',v_license.created_at,'issued_at',v_license.issued_at,'duration_days',v_license.duration_days,'activation_policy',v_license.activation_policy,'first_activated_at',v_license.first_activated_at,'entitlement_version',v_license.entitlement_version),'activation','PENDING ACTIVATION');
  end if;
  insert into public.helix_licenses(member_id,product_slug,license_key_hash,license_key_hint,status,expires_at,max_accounts,issued_at,duration_days,activation_policy,first_activated_at,activation_memo)
  values(p_member_id,p_product_slug,p_legacy_hash,'PORTAL OTP ONLY','active',null,p_max_accounts,now(),p_duration_days,'first_activation',null,left(coalesce(p_memo,''),300))
  returning * into v_license;
  insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
  values(v_license.id,p_actor_id,'created',jsonb_build_object('activation_policy','first_activation','duration_days',p_duration_days,'max_accounts',p_max_accounts));
  insert into public.helix_admin_license_requests(idempotency_key,actor_id,member_id,license_id) values(p_idempotency_key,p_actor_id,p_member_id,v_license.id);
  return jsonb_build_object('ok',true,'license',jsonb_build_object('id',v_license.id,'member_id',v_license.member_id,'product_slug',v_license.product_slug,'license_key_hint',v_license.license_key_hint,'status',v_license.status,'expires_at',v_license.expires_at,'max_accounts',v_license.max_accounts,'created_at',v_license.created_at,'issued_at',v_license.issued_at,'duration_days',v_license.duration_days,'activation_policy',v_license.activation_policy,'first_activated_at',v_license.first_activated_at,'entitlement_version',v_license.entitlement_version),'activation','PENDING ACTIVATION');
end $$;

create or replace function public.helix_pairing_lookup(p_code_hash text,p_member_id uuid,p_license_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pair public.helix_pairing_requests; v_license public.helix_licenses;
begin
  select * into v_pair from public.helix_pairing_requests where code_hash=p_code_hash for update;
  if not found or v_pair.state<>'pending' or v_pair.expires_at<=now() or v_pair.attempts>=10 then return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  select * into v_license from public.helix_licenses where id=p_license_id and member_id=p_member_id for share;
  if not found then update public.helix_pairing_requests set attempts=attempts+1 where id=v_pair.id; return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  if v_license.status<>'active' or (v_license.expires_at is not null and v_license.expires_at<=now()) then return jsonb_build_object('ok',false,'error_code','LICENSE_NOT_ACTIVE'); end if;
  return jsonb_build_object('ok',true,'pairing_request_id',v_pair.id,'broker_server',v_pair.broker_server,'account_login',v_pair.account_login,'mode',v_pair.mode,'expires_at',v_pair.expires_at,'license_id',v_license.id,'license_hint',v_license.license_key_hint);
end $$;

create or replace function public.helix_admin_update_license(p_license_id uuid,p_actor_id uuid,p_status text default null,p_max_accounts integer default null,p_expires_at timestamptz default null,p_duration_days integer default null,p_reason text default '')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_license public.helix_licenses;v_slots integer;v_event public.helix_event_type:='created';v_expiry timestamptz;
begin
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED'); end if;
  if length(trim(coalesce(p_reason,'')))<3 or length(p_reason)>300 then return jsonb_build_object('ok',false,'error_code','REASON_REQUIRED'); end if;
  if p_status is not null and p_status not in ('active','suspended','revoked','expired') then return jsonb_build_object('ok',false,'error_code','INVALID_STATUS'); end if;
  if p_max_accounts is not null and p_max_accounts not between 1 and 5 then return jsonb_build_object('ok',false,'error_code','INVALID_SLOT_LIMIT'); end if;
  if p_duration_days is not null and p_duration_days not between 1 and 3650 then return jsonb_build_object('ok',false,'error_code','INVALID_DURATION'); end if;
  select * into v_license from public.helix_licenses where id=p_license_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','LICENSE_NOT_FOUND'); end if;
  if p_max_accounts is not null then
    select count(*) into v_slots from public.helix_license_bindings where license_id=v_license.id and released_at is null;
    if v_slots>p_max_accounts then return jsonb_build_object('ok',false,'error_code','ACTIVE_SLOTS_EXCEED_LIMIT','active_slots',v_slots); end if;
  end if;
  if p_expires_at is not null and v_license.activation_policy='first_activation' and v_license.first_activated_at is null then
    return jsonb_build_object('ok',false,'error_code','PENDING_DURATION_REQUIRED');
  end if;
  if p_duration_days is not null and v_license.activation_policy='first_activation' and v_license.first_activated_at is null then
    update public.helix_licenses set duration_days=p_duration_days where id=v_license.id;
  elsif p_duration_days is not null then
    v_expiry:=greatest(coalesce(v_license.expires_at,now()),now())+make_interval(days=>p_duration_days);
    update public.helix_licenses set expires_at=v_expiry,status='active' where id=v_license.id;
  end if;
  if p_expires_at is not null then update public.helix_licenses set expires_at=p_expires_at where id=v_license.id; end if;
  if p_status is not null then update public.helix_licenses set status=p_status::public.helix_license_status where id=v_license.id; end if;
  if p_max_accounts is not null then update public.helix_licenses set max_accounts=p_max_accounts where id=v_license.id; end if;
  if p_status in ('suspended','revoked','expired') then v_event:=p_status::public.helix_event_type; end if;
  update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=now() where id=v_license.id returning * into v_license;
  insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
    values(v_license.id,p_actor_id,v_event,jsonb_build_object('action','license_updated','status',p_status,'max_accounts',p_max_accounts,'expires_at',p_expires_at,'duration_days',p_duration_days,'reason',left(p_reason,300)));
  return jsonb_build_object('ok',true,'license',jsonb_build_object('id',v_license.id,'member_id',v_license.member_id,'product_slug',v_license.product_slug,'license_key_hint',v_license.license_key_hint,'status',v_license.status,'expires_at',v_license.expires_at,'max_accounts',v_license.max_accounts,'duration_days',v_license.duration_days,'activation_policy',v_license.activation_policy,'first_activated_at',v_license.first_activated_at,'entitlement_version',v_license.entitlement_version));
end $$;

create or replace function public.helix_pairing_approve(p_code_hash text,p_license_id uuid,p_member_id uuid,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pair public.helix_pairing_requests; v_license public.helix_licenses; v_binding public.helix_license_bindings; v_slots integer; v_now timestamptz:=now(); v_activated boolean:=false; v_reactivated boolean:=false;
begin
  select * into v_pair from public.helix_pairing_requests where code_hash=p_code_hash for update;
  if not found then return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  if v_pair.state='approved' then return jsonb_build_object('ok',true,'state','APPROVED','binding_id',v_pair.binding_id,'license_id',v_pair.license_id,'idempotent',true); end if;
  if v_pair.state<>'pending' then return jsonb_build_object('ok',false,'error_code',case when v_pair.state='expired' then 'PAIRING_EXPIRED' else 'PAIRING_CONSUMED' end); end if;
  if v_pair.expires_at<=v_now or v_pair.attempts>=10 then update public.helix_pairing_requests set state='expired' where id=v_pair.id; return jsonb_build_object('ok',false,'error_code','PAIRING_EXPIRED'); end if;
  select * into v_license from public.helix_licenses where id=p_license_id and member_id=p_member_id for update;
  if not found then update public.helix_pairing_requests set attempts=attempts+1 where id=v_pair.id; return jsonb_build_object('ok',false,'error_code','INVALID_PAIRING'); end if;
  if v_license.status<>'active' then return jsonb_build_object('ok',false,'error_code',case v_license.status when 'suspended' then 'LICENSE_SUSPENDED' when 'revoked' then 'LICENSE_REVOKED' else 'LICENSE_NOT_ACTIVE' end); end if;
  if v_license.expires_at is not null and v_license.expires_at<=v_now then return jsonb_build_object('ok',false,'error_code','LICENSE_EXPIRED'); end if;
  select * into v_binding from public.helix_license_bindings where license_id=v_license.id and account_fingerprint=v_pair.account_fingerprint for update;
  if not found then
    select count(*) into v_slots from public.helix_license_bindings where license_id=v_license.id and released_at is null;
    if v_slots>=v_license.max_accounts then return jsonb_build_object('ok',false,'error_code','ACCOUNT_LIMIT_REACHED'); end if;
    insert into public.helix_license_bindings(license_id,broker_server,account_login,account_fingerprint,mode)
      values(v_license.id,v_pair.broker_server,v_pair.account_login,v_pair.account_fingerprint,v_pair.mode) returning * into v_binding;
  else
    if v_binding.released_at is not null then
      select count(*) into v_slots from public.helix_license_bindings where license_id=v_license.id and released_at is null;
      if v_slots>=v_license.max_accounts then return jsonb_build_object('ok',false,'error_code','ACCOUNT_LIMIT_REACHED'); end if;
      v_reactivated:=true;
      -- A released binding's prior authorization remains revoked permanently.
      update public.helix_license_sessions set revoked_at=coalesce(revoked_at,v_now),revoke_reason=coalesce(revoke_reason,'binding_released')
        where binding_id=v_binding.id;
    end if;
    update public.helix_license_bindings set broker_server=v_pair.broker_server,account_login=v_pair.account_login,mode=v_pair.mode,
      last_sync_at=v_now,released_at=null where id=v_binding.id returning * into v_binding;
  end if;
  if v_license.activation_policy='first_activation' and v_license.first_activated_at is null then
    update public.helix_licenses set first_activated_at=v_now,issued_at=coalesce(issued_at,v_now),
      expires_at=v_now+make_interval(days=>coalesce(duration_days,730)),entitlement_version=entitlement_version+1,updated_at=v_now
      where id=v_license.id returning * into v_license;
    v_activated:=true;
  else
    update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id returning * into v_license;
  end if;
  update public.helix_pairing_requests set state='approved',member_id=p_member_id,license_id=v_license.id,binding_id=v_binding.id,approved_at=v_now where id=v_pair.id;
  insert into public.helix_license_sessions(pairing_request_id,license_id,binding_id,session_secret_hash)
    values(v_pair.id,v_license.id,v_binding.id,v_pair.session_secret_hash)
    on conflict(pairing_request_id) do nothing;
  insert into public.helix_license_events(license_id,actor_id,event_type,binding_id,metadata)
    values(v_license.id,p_actor_id,case when v_activated then 'activated'::public.helix_event_type else 'sync'::public.helix_event_type end,v_binding.id,jsonb_build_object('source','otp_pairing','binding_reactivated',v_reactivated));
  return jsonb_build_object('ok',true,'state','APPROVED','binding_id',v_binding.id,'license_id',v_license.id,'entitlement_version',v_license.entitlement_version);
end $$;

create or replace function public.helix_pairing_poll(p_session_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pair public.helix_pairing_requests; v_session public.helix_license_sessions; v_license public.helix_licenses; v_binding public.helix_license_bindings;
begin
  select * into v_pair from public.helix_pairing_requests where session_secret_hash=p_session_hash;
  if not found then return jsonb_build_object('state','REJECTED','error_code','INVALID_SESSION'); end if;
  if v_pair.state='pending' and v_pair.expires_at<=now() then update public.helix_pairing_requests set state='expired' where id=v_pair.id; return jsonb_build_object('state','EXPIRED','error_code','PAIRING_EXPIRED'); end if;
  if v_pair.state='pending' then return jsonb_build_object('state','PENDING','expires_at',v_pair.expires_at); end if;
  if v_pair.state<>'approved' then return jsonb_build_object('state',upper(v_pair.state),'error_code','PAIRING_NOT_APPROVED'); end if;
  select * into v_session from public.helix_license_sessions where pairing_request_id=v_pair.id and session_secret_hash=p_session_hash and revoked_at is null;
  if not found then return jsonb_build_object('state','REJECTED','error_code','SESSION_REVOKED'); end if;
  select * into v_license from public.helix_licenses where id=v_session.license_id for update;
  select * into v_session from public.helix_license_sessions where id=v_session.id and revoked_at is null for update;
  if not found then return jsonb_build_object('state','REJECTED','error_code','SESSION_REVOKED'); end if;
  select * into v_binding from public.helix_license_bindings where id=v_session.binding_id for update;
  if not found or v_binding.released_at is not null then return jsonb_build_object('state','REJECTED','error_code','BINDING_RELEASED'); end if;
  if v_license.status<>'active' then return jsonb_build_object('state','REJECTED','error_code',case v_license.status when 'suspended' then 'LICENSE_SUSPENDED' when 'revoked' then 'LICENSE_REVOKED' else 'LICENSE_NOT_ACTIVE' end); end if;
  if v_license.expires_at is not null and v_license.expires_at<=now() then return jsonb_build_object('state','REJECTED','error_code','LICENSE_EXPIRED'); end if;
  update public.helix_license_sessions set last_seen_at=now(),last_successful_sync_at=now() where id=v_session.id;
  update public.helix_license_bindings set last_sync_at=now() where id=v_binding.id;
  update public.helix_licenses set last_successful_sync_at=now() where id=v_license.id;
  return jsonb_build_object('state','APPROVED','entitlement',jsonb_build_object('protocol_version','v1','license_id',v_license.id,'binding_id',v_binding.id,'status','ACTIVE','expires_at',v_license.expires_at,'entitlement_version',v_license.entitlement_version,'server_time',now(),'account_fingerprint',v_binding.account_fingerprint));
end $$;

create or replace function public.helix_license_sync(p_session_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_session public.helix_license_sessions; v_license public.helix_licenses; v_binding public.helix_license_bindings; v_now timestamptz:=now();
begin
  select * into v_session from public.helix_license_sessions where session_secret_hash=p_session_hash;
  if not found or v_session.revoked_at is not null then return jsonb_build_object('state','REVOKED','error_code','SESSION_REVOKED','server_time',v_now); end if;
  select * into v_license from public.helix_licenses where id=v_session.license_id for update;
  select * into v_session from public.helix_license_sessions where id=v_session.id and revoked_at is null for update;
  if not found then return jsonb_build_object('state','REVOKED','error_code','SESSION_REVOKED','server_time',v_now); end if;
  select * into v_binding from public.helix_license_bindings where id=v_session.binding_id for update;
  if not found then return jsonb_build_object('state','REVOKED','error_code','BINDING_RELEASED','server_time',v_now); end if;
  if v_binding.released_at is not null then return jsonb_build_object('state','REVOKED','error_code','BINDING_RELEASED','server_time',v_now); end if;
  if v_license.status<>'active' then return jsonb_build_object('state',upper(v_license.status),'error_code',case v_license.status when 'suspended' then 'LICENSE_SUSPENDED' when 'revoked' then 'LICENSE_REVOKED' else 'LICENSE_NOT_ACTIVE' end,'server_time',v_now); end if;
  if v_license.expires_at is not null and v_license.expires_at<=v_now then
    update public.helix_licenses set status='expired',entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id;
    insert into public.helix_license_events(license_id,event_type,metadata) values(v_license.id,'expired','{"source":"license_sync"}'::jsonb);
    return jsonb_build_object('state','EXPIRED','error_code','LICENSE_EXPIRED','server_time',v_now);
  end if;
  update public.helix_license_sessions set last_seen_at=v_now,last_successful_sync_at=v_now where id=v_session.id;
  update public.helix_license_bindings set last_sync_at=v_now where id=v_binding.id;
  update public.helix_licenses set last_successful_sync_at=v_now where id=v_license.id;
  return jsonb_build_object('state','ACTIVE','server_time',v_now,'entitlement',jsonb_build_object('protocol_version','v1','license_id',v_license.id,'binding_id',v_binding.id,'status','ACTIVE','expires_at',v_license.expires_at,'entitlement_version',v_license.entitlement_version,'server_time',v_now,'account_fingerprint',v_binding.account_fingerprint));
end $$;

create or replace function public.helix_release_binding(p_member_id uuid,p_binding_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_binding public.helix_license_bindings; v_license public.helix_licenses; v_now timestamptz:=now();
begin
  if length(trim(coalesce(p_reason,'')))<3 or length(p_reason)>300 then return jsonb_build_object('ok',false,'error_code','REASON_REQUIRED'); end if;
  select l.* into v_license from public.helix_license_bindings b join public.helix_licenses l on l.id=b.license_id
    where b.id=p_binding_id and l.member_id=p_member_id for update of l;
  if not found then return jsonb_build_object('ok',false,'error_code','NOT_OWNER'); end if;
  select * into v_binding from public.helix_license_bindings where id=p_binding_id for update;
  if v_binding.released_at is not null then return jsonb_build_object('ok',true,'idempotent',true); end if;
  update public.helix_license_bindings set released_at=v_now where id=v_binding.id;
  update public.helix_license_sessions set revoked_at=v_now,revoke_reason='binding_released' where binding_id=v_binding.id and revoked_at is null;
  update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id;
  insert into public.helix_license_events(license_id,actor_id,event_type,binding_id,metadata)
    values(v_license.id,p_actor_id,'reset',v_binding.id,jsonb_build_object('reason',left(p_reason,300),'source','portal_release'));
  return jsonb_build_object('ok',true,'released_at',v_now,'entitlement_version',v_license.entitlement_version+1);
end $$;

create or replace function public.helix_email_change_request(p_member_id uuid,p_new_email text,p_note text default '')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_member public.helix_members; v_id uuid;
begin
  select * into v_member from public.helix_members where id=p_member_id;
  if not found or lower(v_member.email)=lower(trim(p_new_email)) or trim(p_new_email) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return jsonb_build_object('ok',false,'error_code','INVALID_EMAIL'); end if;
  if exists(select 1 from public.helix_members where lower(email)=lower(trim(p_new_email))) or exists(select 1 from auth.users where lower(email)=lower(trim(p_new_email))) then return jsonb_build_object('ok',false,'error_code','EMAIL_IN_USE'); end if;
  insert into public.helix_email_change_requests(member_id,old_email,new_email,member_note)
    values(p_member_id,v_member.email,lower(trim(p_new_email)),left(coalesce(p_note,''),300)) returning id into v_id;
  return jsonb_build_object('ok',true,'id',v_id,'status','pending');
exception when unique_violation then return jsonb_build_object('ok',false,'error_code','REQUEST_ALREADY_PENDING');
end $$;

create or replace function public.helix_email_change_decide(p_request_id uuid,p_actor_id uuid,p_approve boolean,p_note text default '')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_request public.helix_email_change_requests;
begin
  select * into v_request from public.helix_email_change_requests where id=p_request_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','REQUEST_NOT_FOUND'); end if;
  if v_request.status not in ('pending','approved_awaiting_verification') then return jsonb_build_object('ok',false,'error_code','REQUEST_NOT_PENDING'); end if;
  if v_request.expires_at<=now() then update public.helix_email_change_requests set status='expired' where id=v_request.id; return jsonb_build_object('ok',false,'error_code','REQUEST_EXPIRED'); end if;
  if p_approve then
    update public.helix_email_change_requests set status='approved_awaiting_verification',admin_actor=p_actor_id,admin_note=left(coalesce(p_note,''),300),decided_at=now() where id=v_request.id;
  else
    update public.helix_email_change_requests set status='rejected',admin_actor=p_actor_id,admin_note=left(coalesce(p_note,''),300),decided_at=now() where id=v_request.id;
  end if;
  insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
    select l.id,p_actor_id,'email',jsonb_build_object('request_id',v_request.id,'decision',case when p_approve then 'approved' else 'rejected' end)
    from public.helix_licenses l where l.member_id=v_request.member_id order by l.created_at desc limit 1;
  return jsonb_build_object('ok',true,'status',case when p_approve then 'approved_awaiting_verification' else 'rejected' end,'member_id',v_request.member_id,'new_email',v_request.new_email);
end $$;

create or replace function public.helix_guard_auth_email_update()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.email is distinct from old.email and not exists(
    select 1 from public.helix_email_change_requests r where r.member_id=new.id
      and lower(r.new_email)=lower(new.email) and r.status='approved_awaiting_verification' and r.expires_at>now()
  ) then raise exception 'EMAIL_CHANGE_NOT_APPROVED'; end if;
  return new;
end $$;
create or replace function public.helix_handle_auth_email_update()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.email_confirmed_at is not null and exists(select 1 from public.helix_email_change_requests r where r.member_id=new.id and lower(r.new_email)=lower(new.email) and r.status='approved_awaiting_verification') then
    update public.helix_members set email=new.email,updated_at=now() where id=new.id;
    update public.helix_email_change_requests set status='completed',verified_at=now()
      where member_id=new.id and status='approved_awaiting_verification' and lower(new_email)=lower(new.email);
  end if;
  return new;
end $$;
drop trigger if exists guard_auth_user_email_update_helix on auth.users;
create trigger guard_auth_user_email_update_helix before update of email on auth.users
  for each row execute procedure public.helix_guard_auth_email_update();
drop trigger if exists on_auth_user_email_updated_helix on auth.users;
create trigger on_auth_user_email_updated_helix after update of email,email_confirmed_at on auth.users
  for each row execute procedure public.helix_handle_auth_email_update();

create or replace function public.helix_ingest_telemetry_deals(p_session_hash text,p_deals jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_session public.helix_license_sessions; v_license public.helix_licenses; v_deal jsonb; v_count integer:=0; v_pos text; v_net_volume numeric; v_pnl numeric; v_ccy_count integer; v_opened timestamptz; v_closed timestamptz; v_currency text; v_symbol text; v_has_helix boolean; v_non_helix boolean; v_ambiguous boolean;
begin
  if jsonb_typeof(p_deals)<>'array' or jsonb_array_length(p_deals)<1 or jsonb_array_length(p_deals)>2000 then return jsonb_build_object('ok',false,'error_code','INVALID_BATCH'); end if;
  select * into v_session from public.helix_license_sessions where session_secret_hash=p_session_hash and revoked_at is null;
  if not found then return jsonb_build_object('ok',false,'error_code','SESSION_REVOKED'); end if;
  select * into v_license from public.helix_licenses where id=v_session.license_id for update;
  select * into v_session from public.helix_license_sessions where id=v_session.id and revoked_at is null for update;
  if not found then return jsonb_build_object('ok',false,'error_code','SESSION_REVOKED'); end if;
  if v_license.status<>'active' or (v_license.expires_at is not null and v_license.expires_at<=now()) then return jsonb_build_object('ok',false,'error_code','LICENSE_NOT_ACTIVE'); end if;
  if not exists(select 1 from public.helix_license_bindings where id=v_session.binding_id and released_at is null) then return jsonb_build_object('ok',false,'error_code','BINDING_RELEASED'); end if;
  for v_deal in select value from jsonb_array_elements(p_deals) loop
    insert into public.helix_telemetry_deals(binding_id,deal_ticket,position_id,occurred_at,direction,entry_kind,volume,profit,commission,swap,fee,currency,symbol,magic)
    values(v_session.binding_id,v_deal->>'deal_ticket',v_deal->>'position_id',(v_deal->>'occurred_at')::timestamptz,v_deal->>'direction',v_deal->>'entry_kind',
      (v_deal->>'volume')::numeric,(v_deal->>'profit')::numeric,(v_deal->>'commission')::numeric,(v_deal->>'swap')::numeric,(v_deal->>'fee')::numeric,
      v_deal->>'currency',v_deal->>'symbol',(v_deal->>'magic')::bigint)
    on conflict(binding_id,deal_ticket) do update set position_id=excluded.position_id,occurred_at=excluded.occurred_at,direction=excluded.direction,entry_kind=excluded.entry_kind,
      volume=excluded.volume,profit=excluded.profit,commission=excluded.commission,swap=excluded.swap,fee=excluded.fee,currency=excluded.currency,symbol=excluded.symbol,magic=excluded.magic
      where public.helix_telemetry_deals.position_id is distinct from excluded.position_id or public.helix_telemetry_deals.occurred_at is distinct from excluded.occurred_at
        or public.helix_telemetry_deals.profit is distinct from excluded.profit or public.helix_telemetry_deals.commission is distinct from excluded.commission
        or public.helix_telemetry_deals.swap is distinct from excluded.swap or public.helix_telemetry_deals.fee is distinct from excluded.fee;
    v_count:=v_count+1;
  end loop;
  for v_pos in select distinct value->>'position_id' from jsonb_array_elements(p_deals) loop
    select coalesce(sum(case when direction='BUY' then volume else -volume end),0),
      coalesce(sum(profit+commission+swap+fee),0),count(distinct currency),min(currency),min(symbol),min(occurred_at),max(occurred_at),
      bool_or(entry_kind='IN' and exists(select 1 from public.helix_telemetry_magic_allowlist a where a.magic=helix_telemetry_deals.magic and a.enabled)),
      bool_or(entry_kind='IN' and not exists(select 1 from public.helix_telemetry_magic_allowlist a where a.magic=helix_telemetry_deals.magic and a.enabled)),bool_or(entry_kind='INOUT')
    into v_net_volume,v_pnl,v_ccy_count,v_currency,v_symbol,v_opened,v_closed,v_has_helix,v_non_helix,v_ambiguous
    from public.helix_telemetry_deals where binding_id=v_session.binding_id and position_id=v_pos;
    if coalesce(v_ambiguous,false) or coalesce(v_non_helix,true) or coalesce(v_ccy_count,0)<>1 then
      delete from public.helix_completed_trades where binding_id=v_session.binding_id and position_id=v_pos;
    elsif abs(v_net_volume)<=0.0000001 and v_has_helix then
      insert into public.helix_completed_trades(binding_id,position_id,currency,symbol,net_pnl,outcome,family,opened_at,closed_at,updated_at)
      values(v_session.binding_id,v_pos,v_currency,v_symbol,v_pnl,case when v_pnl>0.000001 then 'win' when v_pnl< -0.000001 then 'loss' else 'break_even' end,null,v_opened,v_closed,now())
      on conflict(binding_id,position_id) do update set currency=excluded.currency,symbol=excluded.symbol,net_pnl=excluded.net_pnl,outcome=excluded.outcome,opened_at=excluded.opened_at,closed_at=excluded.closed_at,updated_at=now();
    else
      delete from public.helix_completed_trades where binding_id=v_session.binding_id and position_id=v_pos;
    end if;
  end loop;
  update public.helix_license_sessions set last_seen_at=now(),last_telemetry_sync_at=now() where id=v_session.id;
  return jsonb_build_object('ok',true,'accepted',v_count,'updated_trades',(select count(*) from public.helix_completed_trades where binding_id=v_session.binding_id),'synced_at',now());
end $$;

create or replace function public.helix_member_performance_summary(p_member_id uuid,p_license_id uuid default null,p_binding_id uuid default null,p_from timestamptz default null,p_to timestamptz default null,p_family text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer; v_ccy integer; v_result jsonb;
begin
  if p_family is not null and p_family not in ('unclassified') then return jsonb_build_object('status','UNSUPPORTED_FAMILY'); end if;
  select count(*),count(distinct t.currency) into v_count,v_ccy
  from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
  where l.member_id=p_member_id and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id)
    and (p_from is null or t.closed_at>=p_from) and (p_to is null or t.closed_at<p_to) and (p_family is null or coalesce(t.family,'unclassified')=p_family);
  if v_count=0 then return jsonb_build_object('status','NO_DATA','total_closed_trades',null,'last_sync_at',null); end if;
  if v_ccy>1 then return jsonb_build_object('status','MIXED_CURRENCY','total_closed_trades',v_count,'metrics',null); end if;
  select jsonb_build_object('status','READY','total_closed_trades',count(*),
    'wins',count(*) filter(where outcome='win'),'losses',count(*) filter(where outcome='loss'),'break_even',count(*) filter(where outcome='break_even'),
    'winrate',case when count(*)>0 then round((count(*) filter(where outcome='win')::numeric/count(*)*100),2) else null end,
    'profit_factor',case when abs(coalesce(sum(net_pnl) filter(where net_pnl<0),0))>0 then round((sum(net_pnl) filter(where net_pnl>0)/abs(sum(net_pnl) filter(where net_pnl<0))),4) else null end,
    'net_pnl',round(sum(net_pnl),2),'currency',min(currency),'from',min(closed_at),'to',max(closed_at),
    'last_sync_at',(select max(s.last_telemetry_sync_at) from public.helix_license_sessions s join public.helix_license_bindings b2 on b2.id=s.binding_id join public.helix_licenses l2 on l2.id=b2.license_id where l2.member_id=p_member_id and (p_license_id is null or l2.id=p_license_id) and (p_binding_id is null or b2.id=p_binding_id)))
  into v_result from public.helix_completed_trades t join public.helix_license_bindings b on b.id=t.binding_id join public.helix_licenses l on l.id=b.license_id
  where l.member_id=p_member_id and (p_license_id is null or l.id=p_license_id) and (p_binding_id is null or b.id=p_binding_id)
    and (p_from is null or t.closed_at>=p_from) and (p_to is null or t.closed_at<p_to) and (p_family is null or coalesce(t.family,'unclassified')=p_family);
  return v_result;
end $$;

-- Existing UUID-only RPC remains private and explicitly rejects unactivated licenses.
create or replace function public.helix_touch_binding(p_license uuid,p_server text,p_login text,p_mode text default 'real')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_license public.helix_licenses; v_binding public.helix_license_bindings; v_fp text; v_count integer; v_reactivated boolean:=false;
begin
  select * into v_license from public.helix_licenses where id=p_license for update;
  if not found or v_license.status<>'active' or v_license.expires_at is null or v_license.expires_at<=now() then raise exception 'License is not active'; end if;
  v_fp:=encode(digest(lower(trim(p_server))||':'||trim(p_login),'sha256'),'hex');
  select * into v_binding from public.helix_license_bindings where license_id=p_license and account_fingerprint=v_fp for update;
  if found then
    if v_binding.released_at is not null then
      select public.helix_active_slot_count(p_license) into v_count;
      if v_count>=v_license.max_accounts then raise exception 'Account slot limit reached'; end if;
      v_reactivated:=true;
      update public.helix_license_sessions set revoked_at=coalesce(revoked_at,now()),revoke_reason=coalesce(revoke_reason,'binding_released') where binding_id=v_binding.id;
    end if;
    update public.helix_license_bindings set last_sync_at=now(),released_at=null where id=v_binding.id returning * into v_binding;
  else
    select public.helix_active_slot_count(p_license) into v_count;
    if v_count>=v_license.max_accounts then raise exception 'Account slot limit reached'; end if;
    insert into public.helix_license_bindings(license_id,broker_server,account_login,account_fingerprint,mode)
      values(p_license,p_server,p_login,v_fp,p_mode) returning * into v_binding;
  end if;
  update public.helix_licenses set last_successful_sync_at=now() where id=p_license;
  insert into public.helix_license_events(license_id,event_type,binding_id,metadata) values(p_license,'sync',v_binding.id,jsonb_build_object('source','legacy_touch_binding','binding_reactivated',v_reactivated));
  return jsonb_build_object('status','active','license_id',p_license,'binding_id',v_binding.id,'entitlement_version',v_license.entitlement_version);
end $$;

do $$ declare f text; begin
  foreach f in array array['helix_rate_limit(text,text,integer,integer)','helix_admin_create_license(uuid,uuid,text,text,integer,integer,uuid,text)','helix_admin_update_license(uuid,uuid,text,integer,timestamptz,integer,text)','helix_pairing_start(text,text,text,text,text,text,text,text,text)','helix_pairing_lookup(text,uuid,uuid)','helix_pairing_approve(text,uuid,uuid,uuid)','helix_pairing_poll(text)','helix_license_sync(text)','helix_release_binding(uuid,uuid,uuid,text)','helix_email_change_request(uuid,text,text)','helix_email_change_decide(uuid,uuid,boolean,text)','helix_guard_auth_email_update()','helix_handle_auth_email_update()','helix_ingest_telemetry_deals(text,jsonb)','helix_member_performance_summary(uuid,uuid,uuid,timestamptz,timestamptz,text)','helix_touch_binding(uuid,text,text,text)'] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;

commit;
