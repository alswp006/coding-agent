이 폴더는 “단일 PR(single PR) 기반”으로 AI 개발팀(Planner → Implementer → Reviewer → QA → Release)을 운영하기 위한 공통 규칙/프롬프트/프로젝트 설정을 모아둔 곳입니다.
프로젝트가 바뀌어도 개발팀의 동작 방식은 동일하게 유지하고, 프로젝트별로 달라지는 내용만 얇게 덧씌우는 구조를 사용합니다.

## 목표
•	TDD 기반: 테스트(또는 명확한 완료 조건)를 먼저 정의하고 구현을 진행합니다.
•	단일 PR 원칙: 한 번의 작업 결과는 항상 작고 명확한 1개 PR로 제출합니다.
•	품질 게이트 고정: 아래 커맨드를 통과하지 못하면 PR을 준비 완료로 보지 않습니다.
•	pnpm test
•	pnpm lint
•	pnpm typecheck
•	pnpm format:check
•	범위 통제: 불필요한 리팩터링/대규모 포맷 변경/의존성 추가를 금지합니다.
•	사람 최종 승인: 최종 머지는 사람이 결정합니다(에이전트는 PR을 준비하는 역할).

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
	•	budget.json
반복 횟수/실패 시 중단 조건 등, 작업을 무한 루프로 돌리지 않기 위한 운영 제약을 정의합니다.

프로젝트가 바뀌어도 대체로 수정하지 않습니다.

⸻

### 2) .ai/project/overlay.md

프로젝트별로 달라지는 내용을 적는 곳입니다.
이 파일만 수정하면 동일한 에이전트 팀을 다른 프로젝트에도 그대로 재사용할 수 있습니다.

예:
	•	스택(Next.js/TS/Vitest 등)
	•	폴더 구조 규칙
	•	도메인 규칙(예: 블로그 글 생성/SEO 규칙)
	•	금지사항(예: 의존성 추가 금지, 큰 리팩터링 금지)
	•	완료 조건(Definition of Done)

⸻

### 3) .ai/prompts/

에이전트에게 전달되는 프롬프트 원본입니다.
	•	prompts/core/ : 프로젝트와 무관한 불변 코어 프롬프트
	•	prompts/README.md : 프롬프트 설계 철학(코어+오버레이) 설명

코어 프롬프트는 역할별로 분리되어 있습니다.
	•	system.md: 공통 규칙(단일 PR, TDD, 게이트, 금지사항)
	•	planner.md: 요구사항 → 최소 실행 계획/파일 변경 계획/테스트 계획
	•	implementer.md: 테스트→구현→게이트 통과
	•	reviewer.md: 변경 범위/품질/리스크 리뷰
	•	qa.md: 엣지/회귀 관점의 추가 테스트 및 리스크 점검
	•	release.md: PR 본문 템플릿(요약/테스트/리스크/롤백)

⸻

### 4) .ai/roles/

에이전트 팀 운영 규칙을 문서로 정리해둔 곳입니다.
	•	00-overview.md: 단일 PR 원칙과 역할 흐름(Planner → Implementer → Reviewer → QA → Release)

⸻

## 프로젝트별 적용 방법
1.	새 프로젝트를 템플릿으로 생성한 뒤,
2.	.ai/project/overlay.md만 프로젝트에 맞게 수정합니다.
3.	코어 프롬프트/규칙은 가능한 한 건드리지 않습니다.

이 방식을 쓰면, 프로젝트가 바뀌어도 에이전트 팀의 동작은 항상 같고
프로젝트 정보만 “오버레이”로 바뀌게 됩니다.

⸻

## 권장 워크플로우(단일 PR)
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

## 변경/확장 가이드
•	개발팀 운영 방식 자체를 바꾸고 싶으면: prompts/core/와 roles/를 수정
•	프로젝트마다 다른 규칙만 추가하고 싶으면: project/overlay.md에만 추가
•	품질 게이트 커맨드를 바꾸고 싶으면: config/commands.json 수정

좋습니다. 아래 섹션을 .ai/README.md 맨 아래에 그대로 추가하시면 됩니다.
(현재 템플릿에 scripts/ai-bundle.mjs, scripts/ai-pr.mjs가 존재한다는 전제로 작성했습니다. 만약 ai-bundle.mjs가 아직 없다면 먼저 추가해야 합니다.)

⸻

# 운영 예시: 번들 생성 → diff 적용 → 게이트 → PR 생성

이 템플릿은 에이전트 프레임워크(CrewAI 등)가 없어도, 반자동으로 단일 PR 작업을 반복 가능하도록 구성했습니다.
핵심 아이디어는 다음과 같습니다.
1.	프로젝트 규칙/프롬프트/작업 지시를 한 파일로 “번들링”
2.	번들을 AI에게 전달해 unified diff를 받음
3.	diff를 적용하고 품질 게이트를 통과시키면
4.	자동으로 브랜치/커밋/PR 생성

⸻

## 사전 준비(1회)

1) package.json scripts 확인
package.json에 아래 스크립트가 있어야 합니다.

{
  "scripts": {
    "ai:bundle": "node scripts/ai-bundle.mjs",
    "ai:pr": "node scripts/ai-pr.mjs",

    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "format": "prettier -w .",
    "format:check": "prettier -c ."
  }
}

2) GitHub CLI 설치/로그인(PR 자동 생성에 권장)

brew install gh
gh auth login
gh auth setup-git


⸻

## 매 작업 루틴(단일 PR)

1) 작업 지시서 작성: .ai/TASK.md
프로젝트마다, 작업마다 여기만 수정합니다.

```
# Task

## Goal
- normalizeInput() 함수를 추가한다.

## Requirements
- 입력 문자열 양끝 공백을 제거한다.
- 연속 공백은 1개로 정리한다.
- 빈 문자열이면 에러를 던진다.

## Tests
- src/domain/__tests__/normalizeInput.test.ts
- "  hello   world " → "hello world"
- "" → throws
```

⸻

2) 번들 생성
코어 프롬프트 + 오버레이 + TASK를 합쳐 .ai/PROMPT_BUNDLE.md를 생성합니다.

```
pnpm ai:bundle
```

⸻

3) AI에게 번들 전달 → unified diff 받기
AI에게 다음을 반드시 요구합니다.
•	단일 PR 범위
•	unified diff를 하나의 ```diff 코드블록으로 출력
•	PR 본문(Summary/How to test/Risk & rollback/Notes)도 같이 출력

권장 고정 지시문(복붙용):

```
• 단일 PR 범위로만 변경해라.
• 출력은 반드시 2가지를 포함해라:
    1. ```diff 코드블록 1개 안에 unified diff
    2. PR 본문(Summary / How to test / Risk & rollback / Notes)
• 새 의존성 추가 금지(명시적으로 요청된 경우만).
• 불필요한 리팩터링/대규모 포맷 변경 금지.
• 품질 게이트(pnpm test/lint/typecheck/format:check) 통과 가능한 변경만 제안해라.
```

⸻

4) diff를 patch.diff로 저장
AI가 준 ```diff 내용만 파일로 저장합니다.

cat > patch.diff << 'EOF'
(여기에 AI가 준 diff 내용만 그대로 붙여넣기)
EOF

patch.diff는 로컬 산출물이므로 .gitignore에 포함되어야 합니다.

⸻

5) 자동 PR 생성(브랜치/커밋/푸시/PR)
patch.diff를 적용하고 품질 게이트를 통과하면, 브랜치/커밋/푸시/PR 생성까지 수행합니다.

pnpm ai:pr "feat/normalize-input" "feat: add normalizeInput"

실행 내용(개요):
•	git checkout -b <branch>
•	git apply patch.diff
•	pnpm test/lint/typecheck/format:check
•	git commit
•	git push
•	gh pr create --fill

⸻

권장 운영 팁
•	처음부터 UI(Next app)보다 src/domain 같은 순수 로직부터 TDD로 시작하면 속도와 안정성이 높습니다.
•	“큰 기능”은 한 번에 넣지 말고, PR을 작게 쪼개면 비용($1~2/회) 관리가 쉬워집니다.
•	.ai/project/overlay.md만 프로젝트별로 조정하고, 나머지는 공통 코어로 유지하세요.