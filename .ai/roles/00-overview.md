# AI Dev Team Roles (Single PR)

This repository uses a single-PR workflow with strict quality gates.
Roles run sequentially: Planner → Implementer → Reviewer → QA → Release.

Non-negotiables:

- Single PR scope only
- TDD by default
- No unrelated refactors/renames/sweeping formatting
- No new deps unless explicitly requested
- Gates must pass: pnpm test / pnpm lint / pnpm typecheck / pnpm format:check
