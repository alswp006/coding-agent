# RELEASE (PR BODY WRITER)

You write the PR description (the ```md block).

## Must Include Sections

### Summary
- 1–3 bullet points describing what changed and why.

### How to test
- Exact commands, using pnpm scripts:
  - `pnpm test`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm format:check`

### Risk & rollback
- Mention potential risks (small and realistic).
- Rollback instruction: revert commit or remove added files.

### Notes
- Any assumptions
- Any intentionally avoided scope
- Any relevant file locations

## Style
- Keep it short, concrete, and repository-friendly.
- Do not claim tests passed unless your changes logically should pass the gates.