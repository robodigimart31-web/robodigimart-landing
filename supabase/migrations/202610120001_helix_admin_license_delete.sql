-- Audited soft delete for licenses. Preserve binding and event history while
-- immediately revoking all sessions and entitlement access.
begin;

alter table public.helix_licenses
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

create or replace function public.helix_admin_delete_license(
  p_license_id uuid,
  p_actor_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_license public.helix_licenses;
  v_now timestamptz := now();
  v_sessions integer := 0;
  v_bindings integer := 0;
begin
  if not exists (
    select 1 from public.helix_members where id = p_actor_id and role = 'admin'
  ) then
    return jsonb_build_object('ok', false, 'error_code', 'ADMIN_REQUIRED');
  end if;
  if length(trim(coalesce(p_reason, ''))) not between 3 and 300 then
    return jsonb_build_object('ok', false, 'error_code', 'REASON_REQUIRED');
  end if;

  select * into v_license
    from public.helix_licenses
    where id = p_license_id
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'error_code', 'LICENSE_NOT_FOUND');
  end if;
  if v_license.deleted_at is not null then
    return jsonb_build_object('ok', false, 'error_code', 'LICENSE_ALREADY_DELETED');
  end if;

  update public.helix_licenses
    set status = 'revoked', deleted_at = v_now, deleted_by = p_actor_id,
        entitlement_version = entitlement_version + 1, updated_at = v_now
    where id = p_license_id
    returning * into v_license;

  update public.helix_license_sessions
    set revoked_at = coalesce(revoked_at, v_now),
        revoke_reason = coalesce(revoke_reason, 'license_deleted')
    where license_id = p_license_id and revoked_at is null;
  get diagnostics v_sessions = row_count;

  update public.helix_license_bindings
    set released_at = coalesce(released_at, v_now)
    where license_id = p_license_id and released_at is null;
  get diagnostics v_bindings = row_count;

  insert into public.helix_license_events(license_id, actor_id, event_type, metadata)
    values (
      p_license_id, p_actor_id, 'revoked',
      jsonb_build_object('action', 'license_deleted', 'reason', trim(p_reason),
                         'sessions_revoked', v_sessions, 'bindings_released', v_bindings)
    );

  return jsonb_build_object(
    'ok', true, 'license_id', p_license_id, 'deleted_at', v_license.deleted_at,
    'sessions_revoked', v_sessions, 'bindings_released', v_bindings
  );
end;
$$;

revoke all on function public.helix_admin_delete_license(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.helix_admin_delete_license(uuid, uuid, text)
  to service_role;

commit;
