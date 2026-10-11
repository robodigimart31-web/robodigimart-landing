-- Incremental production migration: suspend member licensing sessions atomically.
-- Safe to rerun. Review and execute manually through Supabase SQL Editor.
begin;

create table if not exists public.helix_member_suspensions (
  member_id uuid primary key references public.helix_members(id) on delete cascade,
  actor_id uuid not null,
  reason text not null check (length(trim(reason)) between 3 and 300),
  suspended_at timestamptz not null default now()
);
alter table public.helix_member_suspensions enable row level security;
revoke all on public.helix_member_suspensions from public, anon, authenticated;
grant all on public.helix_member_suspensions to service_role;

create table if not exists public.helix_member_license_suspensions (
  member_id uuid not null references public.helix_members(id) on delete cascade,
  license_id uuid not null references public.helix_licenses(id) on delete cascade,
  prior_status public.helix_license_status not null,
  actor_id uuid not null,
  reason text not null check (length(trim(reason)) between 3 and 300),
  suspended_at timestamptz not null default now(),
  primary key (member_id, license_id)
);
alter table public.helix_member_license_suspensions enable row level security;
revoke all on public.helix_member_license_suspensions from public, anon, authenticated;
grant all on public.helix_member_license_suspensions to service_role;

create or replace function public.helix_admin_set_member_suspended(
  p_member_id uuid,
  p_actor_id uuid,
  p_suspended boolean,
  p_reason text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.helix_members;
  v_affected integer := 0;
  v_now timestamptz := now();
begin
  if p_suspended is null then return jsonb_build_object('ok',false,'error_code','INVALID_ACTION'); end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 300 then return jsonb_build_object('ok',false,'error_code','REASON_REQUIRED'); end if;
  if not exists(select 1 from public.helix_members where id=p_actor_id and role='admin') then return jsonb_build_object('ok',false,'error_code','ADMIN_REQUIRED'); end if;
  if p_member_id=p_actor_id then return jsonb_build_object('ok',false,'error_code','SELF_SUSPENSION_BLOCKED'); end if;
  select * into v_member from public.helix_members where id=p_member_id for update;
  if not found then return jsonb_build_object('ok',false,'error_code','MEMBER_NOT_FOUND'); end if;
  if v_member.role='admin' then return jsonb_build_object('ok',false,'error_code','ADMIN_TARGET_BLOCKED'); end if;
  perform 1 from public.helix_licenses where member_id=p_member_id order by id for update;

  if p_suspended then
    insert into public.helix_member_suspensions(member_id,actor_id,reason,suspended_at)
      values(p_member_id,p_actor_id,trim(p_reason),v_now)
      on conflict(member_id) do update set actor_id=excluded.actor_id,reason=excluded.reason,suspended_at=excluded.suspended_at;

    insert into public.helix_member_license_suspensions(member_id,license_id,prior_status,actor_id,reason,suspended_at)
      select l.member_id,l.id,l.status,p_actor_id,trim(p_reason),v_now
      from public.helix_licenses l
      where l.member_id=p_member_id and l.status='active'
      on conflict(member_id,license_id) do nothing;

    update public.helix_licenses l
      set status='suspended',entitlement_version=l.entitlement_version+1,updated_at=v_now
      where l.member_id=p_member_id and l.status='active';
    get diagnostics v_affected = row_count;

    update public.helix_license_sessions s
      set revoked_at=coalesce(s.revoked_at,v_now),revoke_reason=coalesce(s.revoke_reason,'member_suspended')
      from public.helix_licenses l
      where l.id=s.license_id and l.member_id=p_member_id and s.revoked_at is null;

    insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
      select l.id,p_actor_id,'suspended',jsonb_build_object('source','member_access','reason',trim(p_reason))
      from public.helix_licenses l
      where l.member_id=p_member_id and l.status='suspended'
        and exists(select 1 from public.helix_member_license_suspensions x where x.member_id=p_member_id and x.license_id=l.id and x.suspended_at=v_now);
  else
    update public.helix_licenses l
      set status=x.prior_status,entitlement_version=l.entitlement_version+1,updated_at=v_now
      from public.helix_member_license_suspensions x
      where x.member_id=p_member_id and x.license_id=l.id and l.status='suspended';
    get diagnostics v_affected = row_count;

    insert into public.helix_license_events(license_id,actor_id,event_type,metadata)
      select x.license_id,p_actor_id,'reset',jsonb_build_object('source','member_access','action','unsuspended','reason',trim(p_reason))
      from public.helix_member_license_suspensions x where x.member_id=p_member_id;
    delete from public.helix_member_license_suspensions where member_id=p_member_id;
    delete from public.helix_member_suspensions where member_id=p_member_id;
    -- Sessions stay revoked after restoration; each terminal must pair again.
  end if;

  return jsonb_build_object('ok',true,'suspended',p_suspended,'licenses_changed',v_affected,'sessions_revoked',p_suspended);
end;
$$;
revoke all on function public.helix_admin_set_member_suspended(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.helix_admin_set_member_suspended(uuid,uuid,boolean,text) to service_role;

commit;
