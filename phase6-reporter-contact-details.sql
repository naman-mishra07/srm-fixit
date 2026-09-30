-- SRM-FixIt Phase 6: verified reporter email and optional student registration number.
-- Run once in Supabase SQL Editor after the Phase 1–5 migrations.

alter table public.profiles
    add column if not exists college_email text,
    add column if not exists registration_number text;

-- Backfill existing accounts. The app refreshes this email after successful SRM sign-in.
update public.profiles p
set college_email = lower(u.email)
from auth.users u
where u.id = p.id
  and u.email is not null
  and (p.college_email is null or p.college_email = '');

-- A student registration number should identify one profile, while faculty can leave it blank.
create unique index if not exists profiles_registration_number_unique_idx
    on public.profiles (upper(btrim(registration_number)))
    where registration_number is not null and btrim(registration_number) <> '';

notify pgrst, 'reload schema';
