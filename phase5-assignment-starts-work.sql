-- SRM-FixIt Phase 5: assigning an open ticket automatically starts the work.
-- Run after Phase 3 in Supabase SQL Editor. This updates existing projects
-- without requiring the full Phase 3 migration to be rerun.

create or replace function public.admin_assign_ticket(target_ticket_id uuid, target_staff_id uuid)
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

-- The existing ticket triggers record both the assignment and status change.
notify pgrst, 'reload schema';
