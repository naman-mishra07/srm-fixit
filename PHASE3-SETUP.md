# SRM-FixIt Phase 3 setup

Run `phase3-workers-assignment-analytics.sql` in Supabase **SQL Editor** after the Phase 2 migrations. This adds ticket status and assignment history, staff assignment, and admin analytics. All maintenance staff use the existing `admin` role and the same Admin Dashboard; there is no separate worker role or dashboard.

## Give campus members access

There is no public registration form in the app. Login is limited in the app to `@srmist.edu.in` addresses. After signing in, any valid account can use the Student/Faculty ticket path. The Admin/Maintenance path asks for the password again and only opens the dashboard for an account already promoted to `admin`. Until SRM single sign-on is connected, an administrator must provision each person's SRM-FixIt account in Supabase Auth. Replace the email below:

To prevent account creation outside the app as well, disable public sign-ups in the Supabase Auth settings. Existing users can still sign in; administrators can provision new app accounts.

```sql
update public.profiles
set role = 'admin'
where id = (
  select id from auth.users where email = 'staff@srmist.edu.in'
);
```

Admins can see and manage tickets, update ticket status, and assign a ticket to any admin account. Assignment is optional and is only used to show who is handling a ticket. SRM portal credentials do not automatically work here unless institutional SSO is configured.
