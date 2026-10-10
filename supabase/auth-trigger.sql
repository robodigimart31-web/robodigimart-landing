-- Run after license-policies.sql. Creates the private member profile at signup.
create or replace function public.helix_handle_new_user()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.helix_members(id,display_name,email)
  values(new.id,coalesce(new.raw_user_meta_data->>'full_name',''),new.email)
  on conflict(id) do update set email=excluded.email,updated_at=now();
  return new;
end; $$;
drop trigger if exists on_auth_user_created_helix on auth.users;
create trigger on_auth_user_created_helix after insert on auth.users
for each row execute procedure public.helix_handle_new_user();
revoke all on function public.helix_handle_new_user() from public,anon,authenticated;
