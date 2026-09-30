-- SRM-FixIt Phase 7: staff completion evidence and reporter confirmation.
-- Run after phase6-reporter-contact-details.sql.

-- Extend existing status check constraints without relying on their generated names.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.tickets'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop execute format('alter table public.tickets drop constraint %I', c.conname); end loop;
  for c in
    select conname from pg_constraint
    where conrelid = 'public.ticket_status_events'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) ilike '%old_status%' or pg_get_constraintdef(oid) ilike '%new_status%')
  loop execute format('alter table public.ticket_status_events drop constraint %I', c.conname); end loop;
end $$;

alter table public.tickets add constraint tickets_status_check
  check (status in ('open', 'in_progress', 'awaiting_confirmation', 'resolved', 'rejected'));
alter table public.ticket_status_events
  add constraint ticket_status_events_old_status_check
  check (old_status in ('open', 'in_progress', 'awaiting_confirmation', 'resolved', 'rejected')),
  add constraint ticket_status_events_new_status_check
  check (new_status in ('open', 'in_progress', 'awaiting_confirmation', 'resolved', 'rejected'));

create table if not exists public.ticket_resolution_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  event_type text not null check (event_type in ('submitted', 'confirmed', 'reopened')),
  resolution_note text,
  evidence_path text,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists ticket_resolution_events_ticket_created_idx
  on public.ticket_resolution_events(ticket_id, created_at desc);
alter table public.ticket_resolution_events enable row level security;
drop policy if exists "reporters and staff view resolution events" on public.ticket_resolution_events;
create policy "reporters and staff view resolution events"
  on public.ticket_resolution_events for select to authenticated
  using (public.is_admin() or exists (
    select 1 from public.tickets t where t.id = ticket_id and t.student_id = auth.uid()
  ));
revoke all on public.ticket_resolution_events from anon, authenticated;
grant select on public.ticket_resolution_events to authenticated;

-- Resolution photos are private. They are readable only by the reporter and staff.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ticket-resolution-evidence', 'ticket-resolution-evidence', false, 5242880,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "staff upload resolution evidence" on storage.objects;
create policy "staff upload resolution evidence" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ticket-resolution-evidence' and public.is_admin()
    and exists (select 1 from public.tickets t where t.id::text = (storage.foldername(name))[1]));
drop policy if exists "reporters and staff read resolution evidence" on storage.objects;
create policy "reporters and staff read resolution evidence" on storage.objects
  for select to authenticated
  using (bucket_id = 'ticket-resolution-evidence' and (public.is_admin() or exists (
    select 1 from public.tickets t where t.id::text = (storage.foldername(name))[1]
      and t.student_id = auth.uid()
  )));
drop policy if exists "staff delete resolution evidence" on storage.objects;
create policy "staff delete resolution evidence" on storage.objects
  for delete to authenticated
  using (bucket_id = 'ticket-resolution-evidence' and public.is_admin());

-- Staff submit the completion note. The status becomes Awaiting Confirmation.
create or replace function public.admin_submit_ticket_resolution(
  target_ticket_id uuid, target_resolution_note text, target_evidence_path text default null
) returns void language plpgsql security definer set search_path = public, storage as $$
declare current_status text;
begin
  if not public.is_admin() then raise exception 'Only staff can submit completion' using errcode = '42501'; end if;
  if length(trim(coalesce(target_resolution_note, ''))) < 5 or length(target_resolution_note) > 1000 then
    raise exception 'Completion note must be between 5 and 1000 characters';
  end if;
  if target_evidence_path is not null and target_evidence_path !~ ('^' || target_ticket_id::text || '/[A-Za-z0-9._-]+$') then
    raise exception 'Evidence path does not match this ticket';
  end if;
  if target_evidence_path is not null and not exists (
    select 1 from storage.objects o where o.bucket_id = 'ticket-resolution-evidence' and o.name = target_evidence_path
  ) then raise exception 'Evidence photo was not uploaded'; end if;
  select status into current_status from public.tickets where id = target_ticket_id for update;
  if current_status not in ('open', 'in_progress') then raise exception 'Ticket is not ready for completion'; end if;
  update public.tickets set status = 'awaiting_confirmation' where id = target_ticket_id;
  insert into public.ticket_resolution_events(ticket_id, actor_id, event_type, resolution_note, evidence_path)
    values (target_ticket_id, auth.uid(), 'submitted', trim(target_resolution_note), target_evidence_path);
end $$;

create or replace function public.student_confirm_ticket_resolution(target_ticket_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.tickets set status = 'resolved'
    where id = target_ticket_id and student_id = auth.uid() and status = 'awaiting_confirmation';
  if not found then raise exception 'Ticket cannot be confirmed by this account'; end if;
  insert into public.ticket_resolution_events(ticket_id, actor_id, event_type)
    values (target_ticket_id, auth.uid(), 'confirmed');
end $$;

create or replace function public.student_reopen_ticket_resolution(target_ticket_id uuid, reopen_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if length(trim(coalesce(reopen_reason, ''))) < 5 or length(reopen_reason) > 1000 then
    raise exception 'Please explain what still needs attention (5 to 1000 characters)';
  end if;
  update public.tickets set status = 'in_progress'
    where id = target_ticket_id and student_id = auth.uid() and status = 'awaiting_confirmation';
  if not found then raise exception 'Ticket cannot be reopened by this account'; end if;
  insert into public.ticket_resolution_events(ticket_id, actor_id, event_type, reason)
    values (target_ticket_id, auth.uid(), 'reopened', trim(reopen_reason));
end $$;

-- Staff may use ordinary workflow statuses, but cannot resolve or bypass reporter confirmation.
create or replace function public.admin_set_ticket_status(target_ticket_id uuid, target_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only staff can change ticket status' using errcode = '42501'; end if;
  if target_status not in ('open', 'in_progress', 'rejected') then raise exception 'Unsupported staff status'; end if;
  update public.tickets set status = target_status where id = target_ticket_id and status <> 'resolved';
  if not found then raise exception 'Ticket not found or already resolved'; end if;
end $$;

-- Disable direct status edits; all updates now pass through role-checked RPCs.
revoke update on public.tickets from authenticated;
revoke update (status) on public.tickets from authenticated;
revoke all on function public.admin_submit_ticket_resolution(uuid, text, text) from public;
revoke all on function public.student_confirm_ticket_resolution(uuid) from public;
revoke all on function public.student_reopen_ticket_resolution(uuid, text) from public;
revoke all on function public.admin_set_ticket_status(uuid, text) from public;
grant execute on function public.admin_submit_ticket_resolution(uuid, text, text) to authenticated;
grant execute on function public.student_confirm_ticket_resolution(uuid) to authenticated;
grant execute on function public.student_reopen_ticket_resolution(uuid, text) to authenticated;
grant execute on function public.admin_set_ticket_status(uuid, text) to authenticated;

notify pgrst, 'reload schema';
