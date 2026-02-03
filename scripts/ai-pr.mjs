import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const PATCH_FILE = "patch.diff";
const GATES_LOG = ".ai/gates.log";
const GATES_LAST_LOG = ".ai/gates.last.log";

function ensureAiDir() {
  fs.mkdirSync(".ai", { recursive: true });
}

function runSync(cmd, args, { capture = false } = {}) {
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
  const r = runSync(cmd, args);
  if (r.status !== 0) process.exit(r.status);
}

function capture(cmd, args) {
  const r = runSync(cmd, args, { capture: true });
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    process.exit(r.status);
  }
  return (r.stdout || "").trim();
}

function readEnv(name) {
  const v = process.env[name];
  return v ? String(v) : "";
}

function writeGatesLog(text) {
  ensureAiDir();
  fs.writeFileSync(GATES_LOG, text, "utf8");
}

function appendLog(buf, s) {
  buf.push(s);
}

async function runStreaming(cmd, args, buf) {
  return await new Promise((resolve) => {
    appendLog(buf, `\n$ ${cmd} ${args.join(" ")}\n`);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.on("data", (d) => {
      const s = d.toString("utf8");
      process.stdout.write(s);
      appendLog(buf, s);
    });

    child.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      process.stderr.write(s);
      appendLog(buf, s);
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}

function rollback({ baseBranch, baseSha, branch }) {
  // gates 로그 보존
  try {
    if (fs.existsSync(GATES_LOG)) {
      ensureAiDir();
      fs.copyFileSync(GATES_LOG, GATES_LAST_LOG);
    }
  } catch {
    // ignore
  }

  // 브랜치/워킹트리 복구
  runSync("git", ["reset", "--hard", baseSha]);
  runSync("git", ["clean", "-fd"]);

  // 원래 브랜치로 복귀
  runSync("git", ["checkout", baseBranch]);

  // 작업 브랜치 삭제
  if (branch && branch !== baseBranch) {
    runSync("git", ["branch", "-D", branch]);
  }
}

async function runGates() {
  const buf = [];
  const steps = [
    ["pnpm", ["test"]],
    ["pnpm", ["lint"]],
    ["pnpm", ["typecheck"]],
    ["pnpm", ["format:check"]],
  ];

  for (const [cmd, args] of steps) {
    const code = await runStreaming(cmd, args, buf);
    if (code !== 0) {
      return { ok: false, log: buf.join(""), code };
    }
  }
  return { ok: true, log: buf.join(""), code: 0 };
}

async function main() {
  const argv = process.argv.slice(2);

  const branch = argv[0] || `feat/ai-${Date.now()}`;
  const title = argv[1] || "chore: ai change";
  const dryRun = argv.includes("--dry-run");

  const bodyFile = readEnv("AI_PR_BODY_FILE");
  const prBody =
    bodyFile && fs.existsSync(bodyFile)
      ? fs.readFileSync(bodyFile, "utf8")
      : "";

  ensureAiDir();

  // git repo 확인
  must("git", ["rev-parse", "--is-inside-work-tree"]);

  // ★ 중요: 시작 시 워킹트리 깨끗한지 확인 (여기서 더러우면 “갑자기 파일이 올라오는” 현상이 생김)
  const dirty = capture("git", ["status", "--porcelain"]);
  if (dirty.trim()) {
    console.error(
      "\n[ai-pr] working tree is not clean. Please commit/stash first.\n",
    );
    console.error(dirty);
    process.exit(2);
  }

  const baseBranch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseSha = capture("git", ["rev-parse", "HEAD"]);

  // 브랜치 리셋 (재실행 안정화)
  must("git", ["checkout", "-B", branch, baseSha]);

  if (!fs.existsSync(PATCH_FILE)) {
    console.error(`\n[ai-pr] ${PATCH_FILE} not found.\n`);
    rollback({ baseBranch, baseSha, branch });
    process.exit(2);
  }

  // patch 적용 체크
  const check = runSync(
    "git",
    ["apply", "--check", "--recount", "--whitespace=nowarn", "-p1", PATCH_FILE],
    { capture: true },
  );
  if (check.status !== 0) {
    writeGatesLog(`[git apply --check failed]\n${check.stderr}\n`);
    rollback({ baseBranch, baseSha, branch });
    process.exit(check.status);
  }

  const apply = runSync(
    "git",
    ["apply", "--recount", "--whitespace=nowarn", "-p1", PATCH_FILE],
    { capture: true },
  );
  if (apply.status !== 0) {
    writeGatesLog(`[git apply failed]\n${apply.stderr}\n`);
    rollback({ baseBranch, baseSha, branch });
    process.exit(apply.status);
  }

  // gates (실시간 출력 + 로그 누적)
  const gates = await runGates();
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
  must("git", ["add", "-A"]);
  must("git", ["commit", "-m", title]);
  must("git", ["push", "-u", "origin", branch]);

  const prArgs = ["pr", "create", "--title", title, "--fill"];
  if (prBody.trim()) prArgs.push("--body", prBody);
  must("gh", prArgs);

  console.log("\n[ai-pr] done.\n");
}

main().catch((e) => {
  console.error("[ai-pr] failed:", e?.message || e);
  process.exit(1);
});
