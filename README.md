# SRM-FixIt

SRM-FixIt is a mobile-friendly campus maintenance ticketing PWA for SRM students and faculty, with a staff dashboard for maintenance and administrators.

## Current features

- SRM email login using Supabase Auth (public registration is not part of the app)
- Student/faculty ticket submission with a required photo and campus location
- Personal ticket list and status history
- Staff dashboard with filters, status updates, optional assignment to staff accounts, duplicate flags, and analytics
- PWA manifest, install guidance, and an offline app shell

## Supabase setup

1. Configure the project URL and publishable key in `supabase-client.js`. The publishable key is intended for browser use; never put a secret/service-role key in this app.
2. Run the base schema and Phase 1 policies from the project's setup history if this is a new Supabase project.
3. Run `phase2-status-notifications.sql` and `phase2-uploads-and-duplicates.sql`.
4. Run `phase3-workers-assignment-analytics.sql`.
5. Disable public sign-ups in Supabase Auth. Provision user accounts through the project administrator. Promote approved maintenance/admin accounts to the `admin` role using `PHASE3-SETUP.md`.
6. Make sure Auth redirect URLs include the local development URL and the deployed app URL.

Students and faculty use the Student/Faculty path. The Admin/Maintenance Team path asks the user to confirm their password and then checks the existing database role; selecting it does not grant staff privileges.

See `PHASE2-SETUP.md`, `PHASE3-SETUP.md`, and `PWA-SETUP.md` for setup details.

## Run locally

Serve this folder over localhost with a static file server, then open `index.html`. Supabase Auth and database features require network access and a configured Supabase project.
