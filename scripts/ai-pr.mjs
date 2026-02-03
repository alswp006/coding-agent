import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PATCH_FILE = "patch.diff";
const GATES_LOG = ".ai/gates.log";
const GATES_LAST_LOG = ".ai/gates.last.log";

/**
 * If set, stage only these files (newline-separated).
 * Provided by ai-run.mjs
 */
const ENV_STAGE_FILES = "AI_STAGE_FILES";

function ensureAiDir() {
  fs.mkdirSync(".ai", { recursive: true });
}

function run(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });

  if (capture) {
    return {
      status: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  return { status: r.status ?? 1, stdout: "", stderr: "" };
}

function must(cmd, args) {
  const r = run(cmd, args);
  if (r.status !== 0) process.exit(r.status);
}

function capture(cmd, args) {
  const r = run(cmd, args, { capture: true });
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    process.exit(r.status);
  }
  return (r.stdout || "").trim();
}

function writeGatesLog(text) {
  ensureAiDir();
  fs.writeFileSync(GATES_LOG, text, "utf8");
}

function readEnv(name) {
  const v = process.env[name];
  return v ? String(v) : "";
}

function rollback({ baseBranch, baseSha, branch }) {
  // gates 로그는 롤백 전에 반드시 보존
  try {
    if (fs.existsSync(GATES_LOG)) {
      ensureAiDir();
      fs.copyFileSync(GATES_LOG, GATES_LAST_LOG);
    }
  } catch {
    // ignore
  }

  // 작업 브랜치에서 변경사항 제거
  run("git", ["reset", "--hard", baseSha]);

  // 중요: 로그/아티팩트는 지우지 않도록 제외(-e)
  run("git", [
    "clean",
    "-fd",
    "-e",
    ".ai/gates.log",
    "-e",
    ".ai/gates.last.log",
    "-e",
    ".ai/last-output.txt",
    "-e",
    "patch.diff",
    "-e",
    ".ai/PR_BODY.md",
    "-e",
    ".ai/PR_BODY.en.md",
  ]);

  // 원래 브랜치로 복귀
  run("git", ["checkout", baseBranch]);

  // 작업 브랜치 삭제
  if (branch && branch !== baseBranch) {
    run("git", ["branch", "-D", branch]);
  }
}

function runGatesCapture() {
  // gates 출력 전체를 모아서 로그 파일로 남기기
  const steps = [
    ["pnpm", ["test"]],
    ["pnpm", ["lint"]],
    ["pnpm", ["typecheck"]],
    // format:check는 실패 확률이 높아서, 템플릿은 "format"을 먼저 실행해 안정화
    ["pnpm", ["format"]],
    ["pnpm", ["format:check"]],
  ];

  let out = "";
  for (const [cmd, args] of steps) {
    const r = run(cmd, args, { capture: true });
    out += `\n$ ${cmd} ${args.join(" ")}\n`;
    out += r.stdout;
    out += r.stderr;
    if (r.status !== 0) return { ok: false, log: out, code: r.status };
  }
  return { ok: true, log: out, code: 0 };
}

/**
 * Parse AI_STAGE_FILES (newline-separated) into a safe argv list.
 * - trims
 * - removes empties
 * - rejects absolute paths and parent traversal
 */
function parseStageFiles() {
  const raw = readEnv(ENV_STAGE_FILES).trim();
  if (!raw) return [];

  const files = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const safe = [];
  for (const f of files) {
    if (f.startsWith("/") || f.startsWith("~")) continue;
    if (f.includes("..")) continue;
    safe.push(f);
  }
  return Array.from(new Set(safe));
}

/**
 * Avoid staging cache/build outputs even if patch touched them.
 * (You can relax this later if you truly want to commit them.)
 */
function isIgnoredFromStaging(p) {
  // hard skip for common junk / accidental tracked caches
  const denyPrefixes = [
    "node_modules/",
    ".next/",
    "dist/",
    "build/",
    ".turbo/",
    ".vite/",
    ".pnpm-store/",
  ];

  for (const pref of denyPrefixes) {
    if (p === pref.slice(0, -1) || p.startsWith(pref)) return true;
  }

  // known bad file from your logs
  if (p.includes("node_modules/.vite/")) return true;
  return false;
}

function stageOnlyTouchedFilesOrAll() {
  const files = parseStageFiles().filter((p) => !isIgnoredFromStaging(p));

  if (files.length) {
    // Stage only listed files
    const res = run("git", ["add", "--", ...files], { capture: true });
    if (res.status !== 0) {
      // Fallback to add -A, but still try to keep junk out
      process.stderr.write(
        `[ai-pr] warning: git add of AI_STAGE_FILES failed, falling back to git add -A\n${res.stderr}\n`,
      );
      must("git", ["add", "-A"]);
      return;
    }
    return;
  }

  // No stage list -> default behavior
  must("git", ["add", "-A"]);
}

function main() {
  const argv = process.argv.slice(2);

  const branch = argv[0] || `feat/ai-${Date.now()}`;
  const title = argv[1] || "chore: ai change";
  const dryRun = argv.includes("--dry-run");

  const bodyFile = readEnv("AI_PR_BODY_FILE"); // ai-run.mjs에서 주입
  const prBody =
    bodyFile && fs.existsSync(bodyFile)
      ? fs.readFileSync(bodyFile, "utf8")
      : "";

  ensureAiDir();

  // 안전장치: git repo 안인지 확인
  must("git", ["rev-parse", "--is-inside-work-tree"]);

  const baseBranch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseSha = capture("git", ["rev-parse", "HEAD"]);

  // 브랜치가 이미 있어도 덮어씀(재실행/재시도에 필수)
  must("git", ["checkout", "-B", branch, baseSha]);

  if (!fs.existsSync(PATCH_FILE)) {
    console.error(`\n[ai-pr] ${PATCH_FILE} not found.\n`);
    rollback({ baseBranch, baseSha, branch });
    process.exit(2);
  }

  // patch 적용(whitespace 경고는 nowarn)
  const check = run(
    "git",
    ["apply", "--check", "--recount", "--whitespace=nowarn", "-p1", PATCH_FILE],
    { capture: true },
  );

  if (check.status !== 0) {
    writeGatesLog(`[git apply --check failed]\n${check.stderr}\n`);
    rollback({ baseBranch, baseSha, branch });
    process.exit(check.status);
  }

  const apply = run(
    "git",
    ["apply", "--recount", "--whitespace=nowarn", "-p1", PATCH_FILE],
    { capture: true },
  );

  if (apply.status !== 0) {
    writeGatesLog(`[git apply failed]\n${apply.stderr}\n`);
    rollback({ baseBranch, baseSha, branch });
    process.exit(apply.status);
  }

  // 품질 게이트
  const gates = runGatesCapture();
  writeGatesLog(gates.log);

  if (!gates.ok) {
    const tail = gates.log.split("\n").slice(-120).join("\n");
    console.error("\n[ai-pr] gates tail (last 120 lines)\n");
    console.error(tail);
    console.error("\n[ai-pr] quality gates failed. Rolling back.\n");
    rollback({ baseBranch, baseSha, branch });
    process.exit(gates.code || 1);
  }

  if (dryRun) {
    console.log("\n[ai-pr] dry-run passed. Rolling back (as designed).\n");
    rollback({ baseBranch, baseSha, branch });
    process.exit(0);
  }

  // 커밋/푸시/PR
  stageOnlyTouchedFilesOrAll();
  must("git", ["commit", "-m", title]);
  must("git", ["push", "-u", "origin", branch]);

  const prArgs = ["pr", "create", "--title", title, "--fill"];
  if (prBody.trim()) prArgs.push("--body", prBody);

  must("gh", prArgs);

  console.log("\n[ai-pr] done.\n");
}

main();
