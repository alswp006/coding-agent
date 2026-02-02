#!/usr/bin/env bash
set -euo pipefail

OUT_DIR=".ai/agent-dump"
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="ai-agent-dump-${TS}.tar.gz"

WITH_ARTIFACTS="${1:-}" # pass --with-artifacts to include logs/outputs

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -f "$src" "$dst"
  fi
}

copy_dir_if_exists() {
  local src="$1"
  local dst="$2"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    rsync -a --exclude 'node_modules' --exclude '.git' "$src/" "$dst/"
  fi
}

# 1) 핵심 스크립트 (engine)
copy_if_exists "scripts/ai-run.mjs"       "$OUT_DIR/scripts/ai-run.mjs"
copy_if_exists "scripts/ai-pr.mjs"        "$OUT_DIR/scripts/ai-pr.mjs"
copy_if_exists "scripts/ai-bundle.mjs"    "$OUT_DIR/scripts/ai-bundle.mjs"
copy_if_exists "scripts/ai-gatekeeper.mjs" "$OUT_DIR/scripts/ai-gatekeeper.mjs"

# 2) 워크플로우/정책
copy_dir_if_exists ".github/workflows" "$OUT_DIR/.github/workflows"
copy_if_exists ".gitignore"     "$OUT_DIR/.gitignore"
copy_if_exists ".gitattributes" "$OUT_DIR/.gitattributes"
copy_if_exists ".prettierignore" "$OUT_DIR/.prettierignore"
copy_if_exists "README.md"      "$OUT_DIR/README.md"

# 3) 패키지/툴 설정
for f in package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.* eslint.config.* .prettierrc*; do
  for hit in $f; do
    [ -e "$hit" ] && copy_if_exists "$hit" "$OUT_DIR/$(basename "$hit")" || true
  done
done

# 4) AI 프롬프트/룰 (정적 자산)
copy_dir_if_exists ".ai/config"  "$OUT_DIR/.ai/config"
copy_dir_if_exists ".ai/prompts" "$OUT_DIR/.ai/prompts"
copy_dir_if_exists ".ai/roles"   "$OUT_DIR/.ai/roles"
copy_dir_if_exists ".ai/project" "$OUT_DIR/.ai/project"
copy_if_exists ".ai/README.md"   "$OUT_DIR/.ai/README.md"

# 5) (옵션) 최근 실행 산출물/로그/입력
if [ "$WITH_ARTIFACTS" = "--with-artifacts" ]; then
  copy_if_exists ".ai/TASK.md"          "$OUT_DIR/.ai/TASK.md"
  copy_if_exists ".ai/PROMPT_BUNDLE.md" "$OUT_DIR/.ai/PROMPT_BUNDLE.md"
  copy_if_exists ".ai/last-output.txt"  "$OUT_DIR/.ai/last-output.txt"
  copy_if_exists ".ai/gates.log"        "$OUT_DIR/.ai/gates.log"
  copy_if_exists ".ai/gates.last.log"   "$OUT_DIR/.ai/gates.last.log"
  copy_if_exists "patch.diff"           "$OUT_DIR/patch.diff"
  copy_if_exists ".ai/PR_BODY.md"       "$OUT_DIR/.ai/PR_BODY.md"
  copy_if_exists ".ai/PR_BODY.en.md"    "$OUT_DIR/.ai/PR_BODY.en.md"
fi

# 6) env 키만 추출(값 마스킹)
{
  echo "# ENV KEYS (values removed)"
  for envf in .env.local .env; do
    if [ -e "$envf" ]; then
      echo "## $envf"
      sed -E 's/\r$//' "$envf" \
        | awk -F= 'NF>=1 {print $1}' \
        | sed -E 's/[[:space:]]+$//' \
        | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' \
        | sort -u
    fi
  done
} > "$OUT_DIR/env.keys.txt" 2>/dev/null || true

# 7) git 스냅샷(원격 마스킹)
{
  echo "# GIT SNAPSHOT"
  git rev-parse --is-inside-work-tree || true
  echo
  echo "## branch"
  git branch --show-current || true
  echo
  echo "## status"
  git status --porcelain=v1 || true
  echo
  echo "## last 30 commits"
  git --no-pager log -30 --oneline || true
  echo
  echo "## remotes (sanitized)"
  git remote -v 2>/dev/null \
    | sed -E 's#(https?://)[^@/]+@#\1***@#g' \
    | sed -E 's#git@([^:]+):#git@***:#g' || true
} > "$OUT_DIR/git.snapshot.txt"

# 8) 아카이브 생성: 덤프 폴더만 압축 (경로 깔끔)
tar -czf "$ARCHIVE" -C "$OUT_DIR/.." "$(basename "$OUT_DIR")"

echo ""
echo "Created: $ARCHIVE"
echo "Contents:"
tar -tzf "$ARCHIVE" | sed -n '1,160p'
