# SRM-FixIt

Mobile-friendly campus maintenance ticketing PWA for SRM students, faculty, and maintenance staff.

## App files

- `index.html`, `student.html`, `staff-login.html`, `developer-login.html`, `admin.html` — sign-in, role choice, ticket reporting, and staff/developer access
- `style.css`, `supabase-client.js`, `admin.js` — shared client and live admin dashboard logic
- `server.js`, `package.json`, `.env.example` — server-side SRM Academia verification and local web server
- `manifest.webmanifest`, `sw.js`, `pwa-install.js`, `icons/` — PWA install and app shell

## Run locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env`.
3. In `.env`, set `SUPABASE_SECRET_KEY` to the project's secret API key (`sb_secret_...`). The legacy `service_role` key can be used as `SUPABASE_SERVICE_ROLE_KEY` instead. The project URL is already filled in.
4. Keep `.env` private. It is ignored by Git. Never place the Supabase secret key in a browser file or commit it.
5. Run `npm install`, then `npm start`.
6. Open `http://localhost:3000`. Use this server instead of VS Code Live Server; the app's `/api/auth/srm` endpoint must share the app's origin.

The backend checks SRM Academia credentials with `reddy-api-srm`, then requests a one-time Supabase sign-in token for the matching FixIt account. It does not use the package's `login()` helper, which can terminate other Academia sessions. Academia passwords and returned portal cookies are not persisted or logged. Supabase sessions require a recent Academia verification and expire from the app after 12 hours.

After successful SRM verification, the server creates a missing FixIt auth account and `student` profile. Existing `admin` and `developer` roles are preserved. Staff/developer dashboards still require their corresponding role; SRM verification alone never grants elevated app access.

`reddy-api-srm` is an unofficial client for SRMIST KTR Academia and is used here only for a temporary prototype. It may stop working if Academia changes its login flow and does not establish official SRM SSO. The user-facing app currently supports `@srmist.edu.in` emails. The backend rate-limits sign-in attempts.

## Supabase setup

The base schema and Phase 1 policies must already exist. In Supabase SQL Editor, run these migrations in order:

1. `phase2-status-notifications.sql`
2. `phase2-uploads-and-duplicates.sql`
3. `phase3-workers-assignment-analytics.sql`
4. `phase4-developer-access.sql` (only if designated developers need full admin access)

Set the project URL and publishable key in `supabase-client.js`. The publishable key is intended for browser use; the secret key belongs only in the backend `.env`. Disable public sign-ups in Supabase Auth and provision the matching `profiles` rows. Promote maintenance/admin accounts by setting their `profiles.role` to `admin` and developer accounts to `developer`.

Any signed-in student profile can use the Student/Faculty ticket path. The Admin/Maintenance path asks for SRM credentials again and checks the account's role. Admin accounts get the staff dashboard; developer accounts get full admin access. The tiny Developer sign-in link is an alternate route for profiles explicitly promoted to `developer`. The Phase 4 migration grants those profiles the same admin RLS access as admins.
