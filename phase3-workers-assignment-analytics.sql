-- SRM-FixIt Phase 3: unified admin staff, ticket assignment, audit events, and analytics.
-- Run after the Phase 2 SQL files in Supabase SQL Editor.

-- All maintenance staff use the existing admin role and admin dashboard.
-- Convert any accounts created under the earlier worker role before removing it.
update public.profiles set role = 'admin' where role = 'maintenance_worker';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
    add constraint profiles_role_check
    check (role in ('student', 'admin'));

alter table public.tickets
    add column if not exists assigned_to uuid references public.profiles(id) on delete set null;
create index if not exists tickets_assigned_to_idx on public.tickets(assigned_to);

-- Ensure the status-history table exists even if its Phase 2 migration was skipped.
create table if not exists public.ticket_status_events (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.tickets(id) on delete cascade,
    student_id uuid not null references public.profiles(id) on delete cascade,
    old_status text not null check (old_status in ('open', 'in_progress', 'resolved', 'rejected')),
    new_status text not null check (new_status in ('open', 'in_progress', 'resolved', 'rejected')),
    created_at timestamptz not null default now()
);

create index if not exists ticket_status_events_student_created_idx
    on public.ticket_status_events(student_id, created_at desc);

alter table public.ticket_status_events enable row level security;
drop policy if exists "students view own status events" on public.ticket_status_events;
create policy "students view own status events"
on public.ticket_status_events for select
using (auth.uid() = student_id);

drop policy if exists "admins view all status events" on public.ticket_status_events;
create policy "admins view all status events"
on public.ticket_status_events for select
using (public.is_admin());
grant select on public.ticket_status_events to authenticated;

-- Track the actor for status changes from this point forward.
alter table public.ticket_status_events
    add column if not exists changed_by uuid references public.profiles(id) on delete set null;

create or replace function public.record_ticket_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.ticket_status_events (ticket_id, student_id, old_status, new_status, changed_by)
    values (new.id, new.student_id, old.status, new.status, auth.uid());
    return new;
end;
$$;

drop trigger if exists tickets_record_status_event on public.tickets;
create trigger tickets_record_status_event
after update of status on public.tickets
for each row
when (old.status is distinct from new.status)
execute function public.record_ticket_status_event();

-- Assignment changes have their own audit trail.
create table if not exists public.ticket_assignment_events (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.tickets(id) on delete cascade,
    previous_assignee_id uuid references public.profiles(id) on delete set null,
    new_assignee_id uuid references public.profiles(id) on delete set null,
    changed_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now()
);

create index if not exists ticket_assignment_events_ticket_created_idx
    on public.ticket_assignment_events(ticket_id, created_at desc);

alter table public.ticket_assignment_events enable row level security;
drop policy if exists "admins view assignment events" on public.ticket_assignment_events;
create policy "admins view assignment events"
on public.ticket_assignment_events for select
using (public.is_admin());
grant select on public.ticket_assignment_events to authenticated;

create or replace function public.record_ticket_assignment_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.ticket_assignment_events
        (ticket_id, previous_assignee_id, new_assignee_id, changed_by)
    values (new.id, old.assigned_to, new.assigned_to, auth.uid());
    return new;
end;
$$;

drop trigger if exists tickets_record_assignment_event on public.tickets;
create trigger tickets_record_assignment_event
after update of assigned_to on public.tickets
for each row
when (old.assigned_to is distinct from new.assigned_to)
execute function public.record_ticket_assignment_event();

-- Remove the earlier separate-worker policies; staff now use admin policies.
drop policy if exists "workers view assigned tickets" on public.tickets;
drop policy if exists "workers update assigned ticket status" on public.tickets;
drop policy if exists "workers view profiles for assigned tickets" on public.profiles;
drop function if exists public.is_maintenance_worker();

-- Admins can update status only; assignment goes through the guarded RPC below.
revoke update on public.tickets from authenticated;
grant update (status) on public.tickets to authenticated;

drop function if exists public.admin_assign_ticket(uuid, uuid);
create function public.admin_assign_ticket(target_ticket_id uuid, target_staff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Only admins can assign tickets' using errcode = '42501';
    end if;

    if target_staff_id is not null and not exists (
        select 1 from public.profiles
        where id = target_staff_id and role = 'admin'
    ) then
        raise exception 'Assignee must be an admin';
    end if;

    update public.tickets
    set assigned_to = target_staff_id,
        status = case
            when target_staff_id is not null and status = 'open' then 'in_progress'
            else status
        end
    where id = target_ticket_id;

    if not found then
        raise exception 'Ticket not found';
    end if;
end;
$$;

revoke all on function public.admin_assign_ticket(uuid, uuid) from public;
grant execute on function public.admin_assign_ticket(uuid, uuid) to authenticated;

-- Admin-only rollup by building, category, and current status.
create or replace function public.get_ticket_analytics()
returns table (
    building text,
    category text,
    total_count bigint,
    open_count bigint,
    in_progress_count bigint,
    resolved_count bigint,
    rejected_count bigint
)
language sql
stable
set search_path = public
as $$
    select
        t.building,
        t.category,
        count(*)::bigint,
        count(*) filter (where t.status = 'open')::bigint,
        count(*) filter (where t.status = 'in_progress')::bigint,
        count(*) filter (where t.status = 'resolved')::bigint,
        count(*) filter (where t.status = 'rejected')::bigint
    from public.tickets t
    where public.is_admin()
    group by t.building, t.category
    order by t.building, t.category;
$$;

revoke all on function public.get_ticket_analytics() from public;
grant execute on function public.get_ticket_analytics() to authenticated;

-- Promote each approved maintenance staff account to admin after signup:
-- update public.profiles
-- set role = 'admin'
-- where id = (select id from auth.users where email = 'staff@srmist.edu.in');

-- Ensure PostgREST sees the new column relationships and RPC functions.
notify pgrst, 'reload schema';
