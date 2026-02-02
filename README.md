# coding-agent

새 프로젝트를 시작할 때마다 세팅에 시간을 쓰지 않기 위해 만든 기본 템플릿입니다.  
Next.js(App Router) + TypeScript + Vitest(TDD) + ESLint/Prettier + PR/CI까지 **“바로 개발 가능한 상태”**를 목표로 합니다.

---

## ✅ What’s included

- Next.js (App Router)
- TypeScript
- Vitest (테스트/TDD)
- ESLint (lint)
- Prettier (format)
- GitHub Actions CI (PR/Push 시 자동 검증)
- PR 템플릿
- `.ai/` 폴더(재사용 가능한 최소 AI 워크플로우 설정)

---

## 🚀 사용 방법

### 1) 템플릿으로 새 레포 만들기

GitHub에서 이 레포가 템플릿으로 설정되어 있다면:

1. **Use this template** → 새 레포 생성
2. 로컬로 클론

```bash
git clone <새 레포 주소>
cd <새 레포 폴더>

2) 설치 & 실행

pnpm install
pnpm dev

브라우저에서 http://localhost:3000 접속되면 완료입니다.

⸻

⚙️ 요구 환경
	•	Node.js: 20 권장
	•	pnpm

버전 확인:

node -v
pnpm -v

pnpm 설치(없을 때):

npm i -g pnpm


⸻

✅ 운영 기준 (로컬/CI 공통)

PR 올리기 전에는 아래 4개가 모두 통과하는 상태를 기본으로 합니다.

pnpm test
pnpm lint
pnpm typecheck
pnpm format:check

	•	pnpm test : Vitest 테스트 실행
	•	pnpm lint : ESLint 검사
	•	pnpm typecheck : TypeScript 타입 검사(tsc --noEmit)
	•	pnpm format:check : Prettier 포맷 검사(불일치 시 실패)

포맷 자동 수정:

pnpm format


⸻

🧪 권장 개발 흐름(TDD)
	1.	테스트 먼저 작성(RED)
	2.	pnpm test로 실패 확인
	3.	최소 구현(GREEN)
	4.	pnpm lint / pnpm typecheck / pnpm format:check까지 통과
	5.	커밋 → PR

⸻

🗂️ 디렉터리 구조 의도

app/          # 라우팅(UI, API Route 등)
src/
  domain/     # 순수 로직(테스트 우선)
  services/   # 외부 연동(LLM/API/DB 등)
  lib/        # 공용 유틸(최소화 권장)
tests/        # (선택) 통합 테스트

테스트 파일은 예를 들어 아래처럼 둡니다.
	•	src/domain/__tests__/something.test.ts

⸻

✅ CI(GitHub Actions)

PR 또는 main 브랜치 push 시, CI가 아래를 자동 실행합니다.
	•	pnpm install --frozen-lockfile
	•	pnpm format:check
	•	pnpm lint
	•	pnpm typecheck
	•	pnpm test

로컬에서 통과했더라도 CI에서 실패할 수 있으니, PR 올리기 전에 로컬에서 한 번 더 돌리는 습관을 권장합니다.

⸻

🤝 spec-agent와 함께 쓰기(권장)
	•	spec-agent가 생성한 work-packets/0001.json 같은 “PR 단위 작업 지시서”를
	•	coding-agent의 .ai/TASK.md 또는 워크플로우에 넣어 한 번에 PR 1개 단위로 구현하는 방식이 안정적입니다.

(연동 방식은 레포의 .ai/ 운영 방식에 맞게 확장해나가면 됩니다.)
```
