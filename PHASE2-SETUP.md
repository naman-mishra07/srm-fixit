# SRM-FixIt Phase 2 setup

Run these SQL files in Supabase **SQL Editor**:

1. Run `phase2-status-notifications.sql` if you have not already. It creates the status-change history used on the student dashboard.
2. Run `phase2-uploads-and-duplicates.sql`. It limits ticket photos to JPEG, PNG, or WebP images up to 5 MB, restricts uploads to each student's own storage folder, and adds the admin duplicate-groups function.

After running the second migration, reload the app. New uploads are checked in the form and enforced again by Supabase Storage. In the admin dashboard, active reports with the same category and normalized building, floor, and room/common-area location are marked as potential duplicates. Resolved and rejected reports are excluded from duplicate groups.
