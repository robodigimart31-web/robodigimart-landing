-- Staged v1.8k release handshake. Apply only while
-- PORTAL_LICENSE_RELEASE_ACK_V18K remains false. Existing released_at values
-- are preserved; legacy sessions and bindings remain unchanged.
begin;

alter table public.helix_license_bindings
  add column if not exists release_state text not null default 'active',
  add column if not exists release_request_id uuid,
  add column if not exists release_requested_at timestamptz;

update public.helix_license_bindings
   set release_state='released'
 where released_at is not null and release_state='active';

do $$ begin
  if not exists (select 1 from pg_constraint where conname='helix_license_bindings_release_state_check') then
    alter table public.helix_license_bindings add constraint helix_license_bindings_release_state_check
      check (release_state in ('active','pending_release','released'));
  end if;
end $$;

create table if not exists public.helix_binding_release_requests (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references public.helix_license_bindings(id) on delete cascade,
  license_id uuid not null references public.helix_licenses(id) on delete cascade,
  requested_by uuid references auth.users(id),
  reason text not null check (length(trim(reason)) between 3 and 300),
  status text not null default 'pending' check (status in ('pending','released','force_released')),
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  finalized_by uuid references auth.users(id),
  finalize_reason text
);
create unique index if not exists helix_binding_release_one_pending_idx
  on public.helix_binding_release_requests(binding_id) where status='pending';
create index if not exists helix_binding_release_status_idx
  on public.helix_binding_release_requests(status,created_at desc);

alter table public.helix_license_bindings drop constraint if exists helix_license_bindings_release_request_fk;
alter table public.helix_license_bindings add constraint helix_license_bindings_release_request_fk
  foreign key (release_request_id) references public.helix_binding_release_requests(id) on delete set null;

alter table public.helix_license_sessions
  add column if not exists release_ack_request_id uuid,
  add column if not exists release_ack_at timestamptz,
  add column if not exists release_ack_orders_clean boolean;

alter table public.helix_license_sessions drop constraint if exists helix_license_sessions_release_ack_fk;
alter table public.helix_license_sessions add constraint helix_license_sessions_release_ack_fk
  foreign key (release_ack_request_id) references public.helix_binding_release_requests(id) on delete set null;

create or replace function public.helix_guard_pending_binding_reactivation_v18k()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old.release_state='pending_release' and new.released_at is null and new.release_state<>'released' then
    raise exception 'BINDING_PENDING_RELEASE';
  end if;
  if old.release_state='released' and new.released_at is null then
    new.release_state:='active';
    new.release_request_id:=null;
    new.release_requested_at:=null;
  end if;
  return new;
end $$;
drop trigger if exists helix_guard_pending_binding_reactivation_v18k on public.helix_license_bindings;
create trigger helix_guard_pending_binding_reactivation_v18k
  before update of released_at on public.helix_license_bindings
  for each row execute function public.helix_guard_pending_binding_reactivation_v18k();

create or replace function public.helix_request_binding_release_v18k(p_member_id uuid,p_binding_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_binding public.helix_license_bindings; v_license public.helix_licenses; v_request public.helix_binding_release_requests;
begin
  if length(trim(coalesce(p_reason,''))) not between 3 and 300 then return jsonb_build_object('ok',false,'error_code','REASON_REQUIRED'); end if;
  select l.* into v_license from public.helix_license_bindings b join public.helix_licenses l on l.id=b.license_id
   where b.id=p_binding_id and l.member_id=p_member_id for update of l;
  if not found then return jsonb_build_object('ok',false,'error_code','NOT_OWNER'); end if;
  select * into v_binding from public.helix_license_bindings where id=p_binding_id for update;
  if v_binding.release_state='released' or v_binding.released_at is not null then
    return jsonb_build_object('ok',true,'state','RELEASED','idempotent',true,'release_id',v_binding.release_request_id);
  end if;
  if v_binding.release_state='pending_release' and v_binding.release_request_id is not null then
    return jsonb_build_object('ok',true,'state','PENDING_RELEASE','idempotent',true,'release_id',v_binding.release_request_id);
  end if;
  insert into public.helix_binding_release_requests(binding_id,license_id,requested_by,reason)
   values(v_binding.id,v_license.id,p_actor_id,left(trim(p_reason),300)) returning * into v_request;
  update public.helix_license_bindings set release_state='pending_release',release_request_id=v_request.id,release_requested_at=now() where id=v_binding.id;
  update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=now() where id=v_license.id;
  insert into public.helix_license_events(license_id,actor_id,event_type,binding_id,metadata)
   values(v_license.id,p_actor_id,'reset',v_binding.id,jsonb_build_object('action','release_requested','release_id',v_request.id,'reason',left(trim(p_reason),300),'source','portal_release_v18k'));
  return jsonb_build_object('ok',true,'state','PENDING_RELEASE','release_id',v_request.id,'slot_retained',true,'requested_at',v_request.created_at);
end $$;

create or replace function public.helix_license_sync_v18k(p_session_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_session public.helix_license_sessions; v_license public.helix_licenses; v_binding public.helix_license_bindings; v_policy public.helix_license_product_policies; v_now timestamptz:=now();
begin
  select * into v_session from public.helix_license_sessions where session_secret_hash=p_session_hash;
  if not found or v_session.revoked_at is not null then return jsonb_build_object('state','RELEASED','error_code','SESSION_REVOKED','server_time',v_now); end if;
  if v_session.expires_at<=v_now then return jsonb_build_object('state','REVOKED','error_code','SESSION_EXPIRED','server_time',v_now); end if;
  select * into v_session from public.helix_license_sessions where id=v_session.id and revoked_at is null for update;
  if not found then return jsonb_build_object('state','RELEASED','error_code','SESSION_REVOKED','server_time',v_now); end if;
  select * into v_binding from public.helix_license_bindings where id=v_session.binding_id for update;
  if not found then return jsonb_build_object('state','RELEASED','error_code','BINDING_NOT_FOUND','server_time',v_now); end if;
  if v_binding.release_state='released' or v_binding.released_at is not null then
    return jsonb_build_object('state','RELEASED','error_code','BINDING_RELEASED','release_id',v_binding.release_request_id,'server_time',v_now);
  end if;
  if v_binding.release_state='pending_release' then
    update public.helix_license_sessions set last_seen_at=v_now,last_successful_sync_at=v_now where id=v_session.id;
    update public.helix_license_bindings set last_sync_at=v_now where id=v_binding.id;
    return jsonb_build_object('state','PENDING_RELEASE','release_id',v_binding.release_request_id,'server_time',v_now,'next_sync_seconds',900);
  end if;
  select * into v_license from public.helix_licenses where id=v_session.license_id for update;
  if v_session.is_canary and not exists(select 1 from public.helix_license_canary_allowlist c join public.helix_pairing_requests p on p.id=v_session.pairing_request_id where c.license_id=v_session.license_id and c.member_id=p.member_id and c.expires_at>v_now) then return jsonb_build_object('state','REVOKED','error_code','CANARY_NOT_ALLOWED','server_time',v_now); end if;
  select * into v_policy from public.helix_license_product_policies where license_id=v_license.id;
  if not found or not exists(select 1 from public.helix_ea_products p where p.ea_product_id=v_session.ea_product_id and p.enabled) or (v_policy.license_scope='product' and not (v_session.ea_product_id=any(v_policy.allowed_products))) then return jsonb_build_object('state','REVOKED','error_code','PRODUCT_NOT_ALLOWED','server_time',v_now); end if;
  if v_license.status<>'active' then return jsonb_build_object('state',upper(v_license.status::text),'error_code',case v_license.status when 'suspended' then 'LICENSE_SUSPENDED' when 'revoked' then 'LICENSE_REVOKED' else 'LICENSE_NOT_ACTIVE' end,'server_time',v_now); end if;
  if v_license.expires_at is not null and v_license.expires_at<=v_now then
    update public.helix_licenses set status='expired',entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id returning * into v_license;
    insert into public.helix_license_events(license_id,event_type,metadata) values(v_license.id,'expired','{"source":"license_sync_v18k"}'::jsonb);
    return jsonb_build_object('state','EXPIRED','error_code','LICENSE_EXPIRED','server_time',v_now);
  end if;
  update public.helix_license_sessions set last_seen_at=v_now,last_successful_sync_at=v_now where id=v_session.id;
  update public.helix_license_bindings set last_sync_at=v_now where id=v_binding.id;
  update public.helix_licenses set last_successful_sync_at=v_now where id=v_license.id returning * into v_license;
  return jsonb_build_object('state','ACTIVE','server_time',v_now,'entitlement',public.helix_v2_entitlement(v_license,v_binding,v_policy,v_session,v_now) || jsonb_build_object('offline_expires_at',least(v_now+interval '120 minutes',coalesce(v_license.expires_at,v_now+interval '120 minutes'))));
end $$;

create or replace function public.helix_release_ack_v18k(p_session_hash text,p_release_id uuid,p_pending_orders_clean boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_session public.helix_license_sessions; v_binding public.helix_license_bindings; v_request public.helix_binding_release_requests; v_now timestamptz:=now(); v_required integer; v_acked integer;
begin
  if p_pending_orders_clean is distinct from true then return jsonb_build_object('ok',false,'error_code','PENDING_ORDERS_NOT_CLEARED'); end if;
  select * into v_session from public.helix_license_sessions where session_secret_hash=p_session_hash;
  if not found then return jsonb_build_object('ok',false,'error_code','SESSION_INVALID'); end if;
  select * into v_binding from public.helix_license_bindings where id=v_session.binding_id for update;
  if not found or v_binding.release_request_id is distinct from p_release_id then return jsonb_build_object('ok',false,'error_code','RELEASE_ID_MISMATCH'); end if;
  select * into v_request from public.helix_binding_release_requests where id=p_release_id and binding_id=v_binding.id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','RELEASE_NOT_FOUND'); end if;
  if v_request.status in ('released','force_released') or v_binding.release_state='released' then return jsonb_build_object('ok',true,'state','RELEASED','release_id',p_release_id,'idempotent',true); end if;
  if v_request.status<>'pending' or v_binding.release_state<>'pending_release' then return jsonb_build_object('ok',false,'error_code','RELEASE_NOT_PENDING'); end if;
  if v_session.revoked_at is not null or v_session.expires_at<=v_now then return jsonb_build_object('ok',false,'error_code','SESSION_REVOKED'); end if;
  update public.helix_license_sessions set release_ack_request_id=p_release_id,release_ack_at=v_now,release_ack_orders_clean=true where id=v_session.id;
  select count(*) into v_required from public.helix_license_sessions where binding_id=v_binding.id and revoked_at is null;
  select count(*) into v_acked from public.helix_license_sessions where binding_id=v_binding.id and revoked_at is null and release_ack_request_id=p_release_id and release_ack_orders_clean is true;
  if v_required=0 or v_acked<v_required then return jsonb_build_object('ok',true,'state','PENDING_RELEASE','release_id',p_release_id,'acked_sessions',v_acked,'required_sessions',v_required); end if;
  update public.helix_license_bindings set release_state='released',released_at=v_now where id=v_binding.id;
  update public.helix_binding_release_requests set status='released',finalized_at=v_now where id=v_request.id;
  update public.helix_license_sessions set revoked_at=coalesce(revoked_at,v_now),revoke_reason=coalesce(revoke_reason,'binding_released_ack') where binding_id=v_binding.id and revoked_at is null;
  update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=v_now where id=v_request.license_id;
  insert into public.helix_license_events(license_id,event_type,binding_id,metadata) values(v_request.license_id,'reset',v_binding.id,jsonb_build_object('action','release_acknowledged','release_id',p_release_id,'acked_sessions',v_acked,'required_sessions',v_required));
  return jsonb_build_object('ok',true,'state','RELEASED','release_id',p_release_id,'released_at',v_now);
end $$;

create or replace function public.helix_force_release_binding_v18k(p_binding_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_binding public.helix_license_bindings; v_license public.helix_licenses; v_request public.helix_binding_release_requests; v_now timestamptz:=now();
begin
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED'); end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 300 then return jsonb_build_object('ok',false,'error_code','REASON_REQUIRED'); end if;
  select * into v_binding from public.helix_license_bindings where id=p_binding_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','BINDING_NOT_FOUND'); end if;
  select * into v_license from public.helix_licenses where id=v_binding.license_id for update;
  if v_binding.release_state='released' or v_binding.released_at is not null then return jsonb_build_object('ok',true,'state','RELEASED','idempotent',true); end if;
  if v_binding.release_request_id is not null then select * into v_request from public.helix_binding_release_requests where id=v_binding.release_request_id for update; end if;
  if not found or v_request.id is null then
    insert into public.helix_binding_release_requests(binding_id,license_id,requested_by,reason) values(v_binding.id,v_license.id,p_actor_id,left(trim(p_reason),300)) returning * into v_request;
  end if;
  update public.helix_license_bindings set release_state='released',release_request_id=v_request.id,release_requested_at=coalesce(release_requested_at,v_now),released_at=v_now where id=v_binding.id;
  update public.helix_binding_release_requests set status='force_released',finalized_at=v_now,finalized_by=p_actor_id,finalize_reason=left(trim(p_reason),300) where id=v_request.id;
  update public.helix_license_sessions set revoked_at=coalesce(revoked_at,v_now),revoke_reason=coalesce(revoke_reason,'admin_force_release') where binding_id=v_binding.id;
  update public.helix_licenses set entitlement_version=entitlement_version+1,updated_at=v_now where id=v_license.id;
  insert into public.helix_license_events(license_id,actor_id,event_type,binding_id,metadata) values(v_license.id,p_actor_id,'reset',v_binding.id,jsonb_build_object('action','admin_force_release','release_id',v_request.id,'reason',left(trim(p_reason),300),'warning_acknowledged',true));
  return jsonb_build_object('ok',true,'state','RELEASED','force_released',true,'release_id',v_request.id,'released_at',v_now);
end $$;

alter table public.helix_binding_release_requests enable row level security;
revoke all on public.helix_binding_release_requests from public,anon,authenticated;
grant select on public.helix_binding_release_requests to service_role;

do $$ declare f text; begin
  revoke all on function public.helix_guard_pending_binding_reactivation_v18k() from public,anon,authenticated,service_role;
  foreach f in array array[
    'helix_request_binding_release_v18k(uuid,uuid,uuid,text)',
    'helix_license_sync_v18k(text)',
    'helix_release_ack_v18k(text,uuid,boolean)',
    'helix_force_release_binding_v18k(uuid,uuid,text)'
  ] loop
    execute format('revoke all on function public.%s from public,anon,authenticated',f);
    execute format('grant execute on function public.%s to service_role',f);
  end loop;
end $$;

commit;
