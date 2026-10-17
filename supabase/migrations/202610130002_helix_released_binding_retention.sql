-- Keep released account history visible for one calendar month, then purge it.
-- PENDING_RELEASE is never eligible; active terminal sessions also prevent purge.
-- A purge preserves the license event trail but deletes binding-linked sessions,
-- pairing/release rows, telemetry deals, and completed-trade rows by FK cascade.
begin;

create extension if not exists pg_cron;

create index if not exists helix_license_bindings_released_retention_idx
  on public.helix_license_bindings(released_at)
  where release_state='released';

create or replace function public.helix_purge_released_bindings_after_one_month()
returns integer
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_candidates jsonb;
  v_binding_ids uuid[];
  v_deleted integer:=0;
begin
  select jsonb_agg(jsonb_build_object(
    'id',stale.id,
    'license_id',stale.license_id,
    'released_at',stale.released_at
  )) into v_candidates
  from (
    select b.id,b.license_id,b.released_at
    from public.helix_license_bindings b
    where b.release_state='released'
      and b.released_at < now()-interval '1 month'
      and not exists (
        select 1 from public.helix_license_sessions s
        where s.binding_id=b.id and s.revoked_at is null
      )
    order by b.released_at,b.id
    limit 500
    for update of b skip locked
  ) stale;

  if v_candidates is null or jsonb_array_length(v_candidates)=0 then
    return 0;
  end if;

  select array_agg((item->>'id')::uuid)
    into v_binding_ids
    from jsonb_array_elements(v_candidates) item;

  -- Retain audit events without keeping a foreign-key link to purged accounts.
  update public.helix_license_events
     set binding_id=null
   where binding_id=any(v_binding_ids);

  insert into public.helix_license_events(license_id,event_type,metadata)
  select (item->>'license_id')::uuid,
         'reset',
         jsonb_build_object(
           'action','released_binding_history_purged_after_one_month',
           'released_at',item->>'released_at'
         )
    from jsonb_array_elements(v_candidates) item;

  delete from public.helix_license_bindings
   where id=any(v_binding_ids)
     and release_state='released'
     and released_at < now()-interval '1 month';
  get diagnostics v_deleted=row_count;
  return v_deleted;
end;
$$;

revoke all on function public.helix_purge_released_bindings_after_one_month() from public,anon,authenticated,service_role;

do $$
declare v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job where jobname='helix-purge-released-bindings-daily'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
  perform cron.schedule(
    'helix-purge-released-bindings-daily',
    '15 2 * * *',
    'select public.helix_purge_released_bindings_after_one_month();'
  );
end;
$$;

commit;
