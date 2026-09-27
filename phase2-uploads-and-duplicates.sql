-- SRM-FixIt Phase 2: enforce photo limits and expose active duplicate groups.
-- Run this once in Supabase SQL Editor.

-- Storage enforces these rules even when a client bypasses the browser form.
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[]
where id = 'ticket-photos';

-- Students can upload only under their own user-id folder. The bucket's
-- allowed_mime_types and file_size_limit enforce content type and size.
drop policy if exists "students upload ticket photos" on storage.objects;
create policy "students upload ticket photos"
on storage.objects for insert
to authenticated
with check (
    bucket_id = 'ticket-photos'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
);

-- Return active ticket groups that match exactly by category and normalized
-- building/floor/room. Only admins receive results; table RLS still applies.
create or replace function public.get_active_duplicate_ticket_groups()
returns table (
    category text,
    building text,
    floor text,
    is_common_area boolean,
    room_number text,
    ticket_count bigint,
    ticket_ids uuid[]
)
language sql
stable
set search_path = public
as $$
    with active_tickets as (
        select
            id,
            category,
            building,
            floor,
            is_common_area,
            room_number,
            created_at,
            lower(btrim(building)) as building_key,
            lower(btrim(floor)) as floor_key,
            case when is_common_area then '' else lower(btrim(room_number)) end as room_key
        from public.tickets
        where status in ('open', 'in_progress')
          and public.is_admin()
    ), duplicate_keys as (
        select category, building_key, floor_key, is_common_area, room_key
        from active_tickets
        group by category, building_key, floor_key, is_common_area, room_key
        having count(*) > 1
    )
    select
        min(t.category),
        min(t.building),
        min(t.floor),
        t.is_common_area,
        case when t.is_common_area then null else min(t.room_number) end,
        count(*)::bigint,
        array_agg(t.id order by t.created_at asc)
    from active_tickets t
    join duplicate_keys d
      using (category, building_key, floor_key, is_common_area, room_key)
    group by t.category, t.building_key, t.floor_key, t.is_common_area, t.room_key
    order by min(t.building), min(t.floor), min(t.category);
$$;

grant execute on function public.get_active_duplicate_ticket_groups() to authenticated;
