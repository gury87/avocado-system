<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Database changes and backups

Before asking the operator to run any SQL migration against the live Supabase
project, request a fresh successful `Avocado backup` workflow run with reason
`before-migration`, and verify the matching `.complete.json` exists in OneDrive.
Do not apply production SQL automatically. A failed/incomplete backup is not a
restore point. Follow BACKUP_SETUP.md. Never log credentials, read their values
from GitHub Secrets, or commit backup data. Synthetic local tests need no cloud
backup. This requirement applies to future live database changes, not to writing
or testing a migration locally.
