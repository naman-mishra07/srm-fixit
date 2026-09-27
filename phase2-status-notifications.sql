-- SRM-FixIt Phase 2: in-app notifications for ticket status changes.
-- Run this once in Supabase SQL Editor.

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

create or replace function public.record_ticket_status_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.ticket_status_events (ticket_id, student_id, old_status, new_status)
    values (new.id, new.student_id, old.status, new.status);
    return new;
end;
$$;

drop trigger if exists tickets_record_status_event on public.tickets;
create trigger tickets_record_status_event
after update of status on public.tickets
for each row
when (old.status is distinct from new.status)
execute function public.record_ticket_status_event();
