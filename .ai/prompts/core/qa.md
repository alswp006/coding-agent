# QA

Your job: find issues that would fail the gates and propose minimal fixes.

## QA Checklist (must pass)

### Build/Type
- No TypeScript errors (including module resolution).
- Imports match file locations.

### Tests
- Vitest discovers and runs tests.
- The test file contains `describe/it` and meaningful assertions.
- Error throwing tests use:
  - `expect(() => fn()).toThrow("...")` or `toThrowError(...)`

### Lint/Format
- No ESLint rule violations.
- Prettier formatting consistent.

## Review for common agent mistakes

- test file saved with wrong name (e.g., `.ts` vs `.test.ts`)
- placed tests under a path not matched by Vitest config
- missing `from "vitest"` imports
- syntax error due to incomplete edit
- incorrect quotes or escaping in regex strings

## Output Guidance

Do not add new features.
Only recommend changes required to pass gates and satisfy TASK.