# Third Layer SCM Dashboard

Static web app (no build step) for the Third Layer Supply Chain Manager.
Talks directly to Supabase (Auth + REST API, access controlled by Row Level Security —
see the main `third-layer-scm` repo's `migrations/004_auth_and_rls.sql`).

Hosted via GitHub Pages. The Supabase project URL and anon/public key are embedded in
`index.html` — this is safe: the anon key grants nothing without a valid logged-in
session, and RLS governs all actual data access server-side.

Source of truth for schema, scripts, and business logic: github.com/Spindle-Ventures/third-layer-scm
