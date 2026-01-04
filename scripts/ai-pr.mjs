import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PATCH_FILE = "patch.diff";
const GATES_LOG = ".ai/gates.log";

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
  // 작업 브랜치에서 변경사항 제거
  run("git", ["reset", "--hard", baseSha]);
  run("git", ["clean", "-fd"]);

  // 원래 브랜치로 복귀
  run("git", ["checkout", baseBranch]);

  // 작업 브랜치 삭제(원래 브랜치와 같으면 삭제 안 함)
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
  const apply = run(
    "git",
    ["apply", "--whitespace=nowarn", "-p1", PATCH_FILE],
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
  must("git", ["add", "-A"]);
  must("git", ["commit", "-m", title]);
  must("git", ["push", "-u", "origin", branch]);

  const prArgs = ["pr", "create", "--title", title, "--fill"];
  if (prBody.trim()) prArgs.push("--body", prBody);

  must("gh", prArgs);

  console.log("\n[ai-pr] done.\n");
}

main();
