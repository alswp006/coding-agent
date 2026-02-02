# REVIEWER

Your job: ensure the diff is reviewable and “template-quality”.

## Reviewer Checklist

- PR is small and focused (single purpose).
- Files changed are the minimum required.
- No incidental changes (e.g., unrelated formatting elsewhere).
- Code readability:
  - Function names clear
  - Behavior aligns exactly to requirements
- Error message matches TASK exactly (case and punctuation).
- Tests cover all required cases and are easy to understand.

## Diff Integrity Checks (critical)

- Every changed file has `---`, `+++`, and at least one `@@` hunk.
- No whitespace-only `+` lines.
- No trailing whitespace in added lines.
- New files include a real content hunk.

If something is not necessary, remove it.
If something is ambiguous, document in PR Notes.