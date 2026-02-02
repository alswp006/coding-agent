# AI Prompts (Core)

이 폴더는 템플릿 레포에서 사용하는 “코딩 에이전트 프롬프트” 모음입니다.

## 구조

- `core/system.md`  
  전역 계약(출력 형식, diff 규칙, 금지사항, 품질 게이트).  
  여기 내용이 가장 중요하며, 다른 역할 프롬프트는 중복을 최소화합니다.

- `core/planner.md`  
  무엇을 바꿀지 최소 변경 계획 수립(실패모드 예방 포함).

- `core/implementer.md`  
  실제 코드/테스트 작성 규칙. (특히 TS/Vitest/import 경로 실수 방지)

- `core/qa.md`  
  게이트 실패 가능성 점검 체크리스트.

- `core/reviewer.md`  
  PR 품질(불필요 변경 제거, 요구사항 정확성, diff 무결성) 점검.

- `core/release.md`  
  PR 본문(`PR_BODY.md`) 작성 규칙.

## 운영 원칙

- 프롬프트를 길게 늘리는 것보다,
  “고정 계약 + 실패모드 제거 + 최소 변경”을 강제하는 편이 안정적입니다.
- 이 레포는 `pnpm test/lint/typecheck/format:check`를 게이트로 사용하므로,
  프롬프트에도 반드시 동일한 기준을 포함합니다.

## 튜닝 팁

1) 품질이 흔들릴 때
- `core/system.md`의 Diff Contract를 더 강하게(헤더-only diff 금지, whitespace-only + 금지 등)
- `core/implementer.md`에 “Vitest import/describe/it 필수”를 강조

2) 너무 많은 파일을 건드릴 때
- `core/reviewer.md`에서 “불필요 변경 제거” 기준을 강화

3) 테스트 파일 경로/이름 실수가 잦을 때
- `core/implementer.md`에 “파일 경로 예시”를 더 구체적으로 추가