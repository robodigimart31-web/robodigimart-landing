# Owner action: audited role management in the Member menu

The portal change adds a “Jadikan Admin / Jadikan Member” action to the existing Member menu. Role updates require a reason and explicit confirmation, are authorized against the current server-verified admin session, and are written through an audited database function. The database rejects self-role changes and demotion of the last remaining admin.

## Enable the production database function

1. Open the correct HELIX Supabase project and go to **SQL Editor**.
2. Open `supabase/migrations/202610110002_helix_admin_member_roles.sql` from this repository. Copy the entire file into a new SQL Editor query.
3. Review the SQL and run it once. It creates the restricted audit table and the `helix_admin_set_member_role` RPC. It does not change existing user roles.
4. Verify the function exists and only `service_role` can execute it:

```sql
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'helix_admin_set_member_role';

select c.relname, c.relrowsecurity,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_can_read,
       has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_read
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'helix_member_role_audit';
```

Expected: function flags `false, false, true`; audit table has RLS enabled and both read flags `false`.

The function returns a normal Supabase JSON RPC result. It makes no initial role changes. After this SQL is installed and the deployed source is live, open **Admin Portal → Member**, choose **Jadikan Admin** on the intended account, enter the reason, and confirm. Then verify that account’s `helix_members.role` is `admin` and an audit row was inserted. Do not use a member session to test admin access.
