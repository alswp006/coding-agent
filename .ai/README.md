이 폴더는 “단일 PR(single PR) 기반”으로 AI 개발팀(Planner → Implementer → Reviewer → QA → Release)을 운영하기 위한 공통 규칙/프롬프트/프로젝트 설정을 모아둔 곳입니다.
프로젝트가 바뀌어도 개발팀의 동작 방식은 동일하게 유지하고, 프로젝트별로 달라지는 내용만 얇게 덧씌우는 구조를 사용합니다.

## 목표

• TDD 기반: 테스트(또는 명확한 완료 조건)를 먼저 정의하고 구현을 진행합니다.
• 단일 PR 원칙: 한 번의 작업 결과는 항상 작고 명확한 1개 PR로 제출합니다.
• 품질 게이트 고정: 아래 커맨드를 통과하지 못하면 PR을 준비 완료로 보지 않습니다.
• pnpm test
• pnpm lint
• pnpm typecheck
• pnpm format:check
• 범위 통제: 불필요한 리팩터링/대규모 포맷 변경/의존성 추가를 금지합니다.
• 사람 최종 승인: 최종 머지는 사람이 결정합니다(에이전트는 PR을 준비하는 역할).

⸻

## 디렉터리 구조

.ai/
README.md
config/
commands.json
budget.json
project/
overlay.md
prompts/
README.md
core/
system.md
planner.md
implementer.md
reviewer.md
qa.md
release.md
roles/
00-overview.md

### 1) .ai/config/

    •	commands.json

에이전트가 품질 검증에 사용하는 표준 커맨드를 정의합니다.
• budget.json
반복 횟수/실패 시 중단 조건 등, 작업을 무한 루프로 돌리지 않기 위한 운영 제약을 정의합니다.

프로젝트가 바뀌어도 대체로 수정하지 않습니다.

⸻

### 2) .ai/project/overlay.md

프로젝트별로 달라지는 내용을 적는 곳입니다.
이 파일만 수정하면 동일한 에이전트 팀을 다른 프로젝트에도 그대로 재사용할 수 있습니다.

예:
• 스택(Next.js/TS/Vitest 등)
• 폴더 구조 규칙
• 도메인 규칙(예: 블로그 글 생성/SEO 규칙)
• 금지사항(예: 의존성 추가 금지, 큰 리팩터링 금지)
• 완료 조건(Definition of Done)

⸻

### 3) .ai/prompts/

에이전트에게 전달되는 프롬프트 원본입니다.
• prompts/core/ : 프로젝트와 무관한 불변 코어 프롬프트
• prompts/README.md : 프롬프트 설계 철학(코어+오버레이) 설명

코어 프롬프트는 역할별로 분리되어 있습니다.
• system.md: 공통 규칙(단일 PR, TDD, 게이트, 금지사항)
• planner.md: 요구사항 → 최소 실행 계획/파일 변경 계획/테스트 계획
• implementer.md: 테스트→구현→게이트 통과
• reviewer.md: 변경 범위/품질/리스크 리뷰
• qa.md: 엣지/회귀 관점의 추가 테스트 및 리스크 점검
• release.md: PR 본문 템플릿(요약/테스트/리스크/롤백)

⸻

### 4) .ai/roles/

에이전트 팀 운영 규칙을 문서로 정리해둔 곳입니다.
• 00-overview.md: 단일 PR 원칙과 역할 흐름(Planner → Implementer → Reviewer → QA → Release)

⸻

## 프로젝트별 적용 방법

1. 새 프로젝트를 템플릿으로 생성한 뒤,
2. .ai/project/overlay.md만 프로젝트에 맞게 수정합니다.
3. 코어 프롬프트/규칙은 가능한 한 건드리지 않습니다.

이 방식을 쓰면, 프로젝트가 바뀌어도 에이전트 팀의 동작은 항상 같고
프로젝트 정보만 “오버레이”로 바뀌게 됩니다.

⸻

권장 워크플로우(단일 PR)

1. 요구사항/테스트 준비
   • 테스트를 먼저 작성하거나, 최소한 완료 조건을 명확히 정의합니다.

2. 구현
   • Implementer가 최소 변경으로 테스트를 통과시키는 구현을 합니다.

3. 리뷰/QA
   • Reviewer/QA가 범위 초과/리스크/엣지 케이스를 점검합니다.

4. PR 준비(Release)
   • PR 본문에는 아래가 포함되어야 합니다.
   • Summary (무엇/왜)
   • How to test (명령어/기대 결과)
   • Risk & rollback (리스크/되돌리는 방법)
   • Notes (가정/후속 과제)

5. 사람이 최종 머지 결정

⸻

흔한 실수/주의 사항
• “작업하다 보니 김에 리팩터링까지…”
→ 금지. 단일 PR 원칙이 깨집니다.
• 포맷/린트가 프로젝트 외 파일까지 건드림
→ .prettierignore, eslint.config.mjs의 ignore를 조정합니다.
• node_modules/, .next/ 커밋됨
→ .gitignore에 반드시 포함되어야 합니다.

⸻

변경/확장 가이드
• 개발팀 운영 방식 자체를 바꾸고 싶으면: prompts/core/와 roles/를 수정
• 프로젝트마다 다른 규칙만 추가하고 싶으면: project/overlay.md에만 추가
• 품질 게이트 커맨드를 바꾸고 싶으면: config/commands.json 수정

⸻

원하시면, 이 .ai/README.md에 이어서 **“실제 실행 흐름(번들 생성 → diff 적용 → 게이트 → PR)”**까지 포함한 “운영 예시 섹션”을 추가해드릴까요? (현재 템플릿에 scripts/ai-bundle.mjs, scripts/ai-pr.mjs를 넣는 방식까지 같이 맞춰드릴 수 있습니다.)
