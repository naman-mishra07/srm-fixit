# SRM-FixIt

Mobile-friendly campus maintenance ticketing PWA for SRM students, faculty, and maintenance staff.

## App files

- `index.html`, `student.html`, `staff-login.html`, `admin.html` — login, role choice, ticket reporting, and staff dashboard
- `style.css`, `supabase-client.js` — shared styles and Supabase connection
- `manifest.webmanifest`, `sw.js`, `pwa-install.js`, `icons/` — PWA install and app shell

## Supabase

The base schema and Phase 1 policies must already exist. In Supabase SQL Editor, run these migrations in order:

1. `phase2-status-notifications.sql`
2. `phase2-uploads-and-duplicates.sql`
3. `phase3-workers-assignment-analytics.sql`

Set the project URL and publishable key in `supabase-client.js`. The publishable key is intended for browser use; never commit a secret/service-role key. Disable public sign-ups in Supabase Auth and provision accounts through the project administrator. Promote maintenance/admin accounts by setting their `profiles.role` to `admin`.

Any signed-in user can use the Student/Faculty ticket path. The Admin/Maintenance path asks for the password again and checks that the account already has the `admin` role.

## Run locally

Serve this directory on `http://localhost` or `http://127.0.0.1` (for example, with VS Code Live Server). PWA service workers do not work from `file://`. Ticket and authentication features require an internet connection.
