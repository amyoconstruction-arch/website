AMYO CONSTRUCTION - WEBSITE OPERATIONS

Ownership and destinations
Use only the Amyoconstruction@gmail.com profile for this project.
Repository: https://github.com/amyoconstruction-arch/website
Supabase project: https://supabase.com/dashboard/project/cqmozlqyduqfrauifavd
Vercel account: https://vercel.com/amyoconstruction-9894
Intended public domain: https://amyoconstruction.com
Business contact and email fallback: Amyoconstruction@gmail.com

Local preview
Use Node.js 22. In this website folder run npm start, then open
http://127.0.0.1:4173. The server binds only to the local computer.
Set PORT to change the port; PORT=0 selects a free local port and prints it.
Run npm test to run the automated API and preview checks.

The preview serves dist/ and the enquiry API. By default the API reports
available:false and the website uses its email fallback. No database is used.
Explicit local database testing requires PREVIEW_ENABLE_INQUIRIES=true plus
the server environment variables below. For that test, use
ALLOWED_ORIGIN=http://127.0.0.1:4173 and NODE_ENV=development. Environment files
are not loaded automatically. Never deploy the preview server as production.

Database setup and verification
1. Open the AMYO Supabase project above, then its SQL editor.
2. Execute supabase/schema.sql. This creates private enquiries and rate-limit
   tables, enables RLS, and grants the submission RPC only to service_role.
3. Execute supabase/verify.sql. It checks create, duplicate, changed-payload
   conflict, rate limiting, consent, and denied anonymous/authenticated access.
   The script rolls back all synthetic test records. If an assertion fails,
   run ROLLBACK before retrying or investigating.
4. Keep database access restricted to authorized AMYO operators.

Vercel deployment
Import the AMYO GitHub repository above into the AMYO Vercel account.
Use the repository folder containing package.json and vercel.json as the root.
Framework preset: Other. Node.js version: 22.x.
Build command: npm test. Output directory: dist.
Static website files are already authored in dist/; no site compilation is
required. Vercel separately deploys api/inquiries.js as the server function.
The checked-in vercel.json supplies these settings and security headers.

Add these environment variables in Vercel project settings:
SUPABASE_URL = the project URL shown in the AMYO Supabase dashboard
SUPABASE_SECRET_KEY = a server-only sb_secret_ key, or legacy service_role JWT
ALLOWED_ORIGIN = https://amyoconstruction.com
ALLOW_VERCEL_PREVIEWS = false

Never place a secret/service_role key in dist/, browser JavaScript, GitHub,
screenshots, or shared messages. The public browser does not need a Supabase
key. Use Vercel's environment settings; .env.example contains names only.
After changing environment variables, deploy again to apply them.

For an explicitly authorized preview submission test, set
ALLOW_VERCEL_PREVIEWS=true for the Preview environment. Only that deployment's
exact VERCEL_URL is allowed; arbitrary vercel.app sites and branch aliases
are not accepted. VERCEL, VERCEL_ENV and VERCEL_URL are supplied by Vercel.

Domain connection
Add amyoconstruction.com and www.amyoconstruction.com to the Vercel project.
In Namecheap, replace conflicting parking/redirect records using the exact
DNS records shown by that Vercel project. Complete any required registration
contact-email verification through the AMYO mailbox. Domain registration
alone does not connect hosting. Confirm Vercel reports valid DNS and HTTPS.
The supplied configuration redirects www to https://amyoconstruction.com.
Verify the live website and a consented enquiry before advertising it as live.

Enquiry operation
GET /api/inquiries returns only {available:true} when server environment
settings are configured. It is a configuration check, not a database health
test. When unavailable, the website offers the AMYO email fallback.
POST /api/inquiries validates the form, consent and same-origin request, then
stores the enquiry using a private Supabase RPC. A repeated UUID with identical
details returns success without creating another enquiry; changed details
with the same UUID return a conflict. Keep the request ID during retries.
Five new enquiries per hashed client IP are allowed per 30-minute window.

Authorized AMYO operators review new enquiries in the Supabase Table Editor,
table public.inquiries, sorted by created_at. The site does not automatically
send email notifications or confirmation emails. Do not promise that an email
was sent merely because the database saved an enquiry. Contact the client
using the details they supplied and consented to share.

Retention
Keep enquiries only while AMYO needs them for the requested work and its
applicable recordkeeping requirements. An authorized operator can delete
handled enquiries from public.inquiries when no longer needed. No automatic
enquiry-deletion period is configured. The application stores an HMAC of the
client IP for rate limiting, not the raw IP; old rate-limit buckets are cleaned
up during later submissions after two days. Hosting services may keep their
own operational logs under their configured policies.

Troubleshooting
If the site offers email only, check all required server environment variables
and redeploy. If a saved-enquiry request fails, verify schema.sql was applied,
the secret belongs to the AMYO project, and the exact website origin matches
ALLOWED_ORIGIN. Do not disable RLS or expose database tables to the browser.
Retry the unchanged form with the same request ID after a temporary failure,
or use Amyoconstruction@gmail.com. A 429 response asks the visitor to wait.
