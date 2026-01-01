# AI workflow (template)

This repository includes a minimal AI-friendly workflow scaffold.

## Quality gates (must be green)
- pnpm test
- pnpm lint
- pnpm typecheck
- pnpm format:check

## Suggested PR workflow
1) Add/modify tests first (RED)
2) Implement (GREEN)
3) Ensure gates are green
4) Open a single PR
