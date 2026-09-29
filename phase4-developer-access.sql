-- SRM-FixIt Phase 4: explicitly granted developer access.
-- Run after the base schema and Phase 3 migration.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
    add constraint profiles_role_check
    check (role in ('student', 'admin', 'developer'));

-- Reuse the existing admin-only RLS policies for developer accounts.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid() and role in ('admin', 'developer')
    );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Promote only approved developers, after their SRM-FixIt account exists:
-- update public.profiles
-- set role = 'developer'
-- where id = (select id from auth.users where email = 'developer@srmist.edu.in');

notify pgrst, 'reload schema';
