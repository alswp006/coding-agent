import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PATCH_FILE = "patch.diff";
const AI_DIR = ".ai";
const GATES_LOG = ".ai/gates.log";
const GATES_LAST_LOG = ".ai/gates.last.log";
const GATES_SUMMARY = ".ai/gates.summary.md";

function ensureAiDir() {
  fs.mkdirSync(AI_DIR, { recursive: true });
}

function run(cmd, args, { capture = false, env } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    env: env ? { ...process.env, ...env } : process.env,
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

function writeFileSafe(p, text) {
  ensureAiDir();
  fs.writeFileSync(p, text, "utf8");
}

function readEnv(name) {
  const v = process.env[name];
  return v ? String(v) : "";
}

function tailLines(text, n = 120) {
  const lines = String(text || "").split("\n");
  return lines.slice(-n).join("\n");
}

function firstMatch(text, re) {
  const m = String(text || "").match(re);
  return m ? m[0] : "";
}

function extractTypecheckErrors(log) {
  const lines = String(log || "").split("\n");
  const errs = [];
  for (const line of lines) {
    if (/\): error TS\d+:/i.test(line) || /error TS\d+:/i.test(line)) {
      errs.push(line.trim());
    }
  }
  return errs;
}

function extractEslintErrors(log) {
  const lines = String(log || "").split("\n");
  const errs = [];
  for (const line of lines) {
    if (
      /\s+error\s+.+\s+@/i.test(line) ||
      /\s+error\s+.+\s+\w+\/\w+/i.test(line)
    ) {
      errs.push(line.trim());
    }
  }
  return errs;
}

function detectCommonFailureHints(log) {
  const hints = [];
  const s = String(log || "");

  if (/@testing-library\/react/.test(s)) {
    hints.push(
      "- Patch introduced `@testing-library/react` but repo doesn't have it. Avoid Testing Library imports or add deps only if TASK allows.",
    );
  }
  if (/\btoBeInTheDocument\b/.test(s)) {
    hints.push(
      "- Patch used `toBeInTheDocument` (jest-dom matcher). Repo likely doesn't include jest-dom. Use basic `expect(...)` or avoid DOM matchers.",
    );
  }
  if (/Cannot find module '@testing-library\/react'/.test(s)) {
    hints.push(
      "- Typecheck failed: `Cannot find module '@testing-library/react'`. Do not add tests that require it.",
    );
  }
  if (/no-explicit-any/.test(s) || /Unexpected any/i.test(s)) {
    hints.push(
      "- ESLint failed: `no-explicit-any`. Replace `any` with `unknown` + narrowing or proper types.",
    );
  }
  if (/vitest\.config\.(ts|js|cjs|mjs)/.test(s)) {
    hints.push(
      "- Patch touched `vitest.config.ts/js/...` but repo likely uses `vitest.config.mts`. Avoid creating/modifying extra vitest configs.",
    );
  }
  if (/app\/drafts\/.*__tests__/.test(s)) {
    hints.push(
      "- Tests under `app/drafts/**/__tests__` often require extra Next/RTL setup and break typecheck. Put smoke tests under `src/__tests__` instead.",
    );
  }
  if (/Object is possibly 'undefined'/.test(s)) {
    hints.push(
      "- Typecheck error: object possibly undefined. Add guards or optional chaining and narrow types.",
    );
  }
  if (/Property 'find' does not exist on type/.test(s)) {
    hints.push(
      "- Typecheck error: invalid method on union type. Narrow the type before calling methods (`typeof === 'string'`, `Array.isArray`, etc.).",
    );
  }
  if (/No test files found, exiting with code 1/i.test(s)) {
    hints.push(
      "- Vitest reports 'No test files found'. This runner treats it as pass now; consider adding at least one smoke test if you want coverage.",
    );
  }

  return hints;
}

function summarizeGates(log) {
  const s = String(log || "");
  const summary = [];

  const failedStep =
    firstMatch(
      s,
      /\$ pnpm (test|lint|typecheck|format|format:check)\b[\s\S]*?(?=\n\$ pnpm |\s*$)/i,
    ) || "";

  const stepNameMatch = failedStep.match(
    /\$ pnpm (test|lint|typecheck|format|format:check)/i,
  );
  const stepName = stepNameMatch ? stepNameMatch[1] : "unknown";

  summary.push(`## Gates failure summary`);
  summary.push(`- Failed step: **${stepName}**`);

  if (stepName === "typecheck") {
    const errs = extractTypecheckErrors(failedStep);
    summary.push(`- TypeScript errors: **${errs.length}**`);
    if (errs.length) {
      summary.push("");
      summary.push("### Top TS errors (up to 12)");
      for (const e of errs.slice(0, 12)) summary.push(`- ${e}`);
    }
  } else if (stepName === "lint") {
    const errs = extractEslintErrors(failedStep);
    summary.push(`- ESLint errors: **${errs.length}**`);
    if (errs.length) {
      summary.push("");
      summary.push("### Top ESLint errors (up to 12)");
      for (const e of errs.slice(0, 12)) summary.push(`- ${e}`);
    }
  } else if (stepName === "test") {
    summary.push("");
    summary.push("### Vitest tail (last 40 lines)");
    summary.push("```");
    summary.push(tailLines(failedStep, 40));
    summary.push("```");
  } else if (stepName === "format" || stepName === "format:check") {
    summary.push("");
    summary.push("### Format tail (last 60 lines)");
    summary.push("```");
    summary.push(tailLines(failedStep, 60));
    summary.push("```");
  } else {
    summary.push("");
    summary.push("### Log tail (last 120 lines)");
    summary.push("```");
    summary.push(tailLines(s, 120));
    summary.push("```");
  }

  const hints = detectCommonFailureHints(s);
  if (hints.length) {
    summary.push("");
    summary.push("## Hints for next attempt");
    for (const h of hints) summary.push(h);
  }

  return summary.join("\n") + "\n";
}

function rollback({ baseBranch, baseSha, branch }) {
  try {
    if (fs.existsSync(GATES_LOG)) {
      ensureAiDir();
      fs.copyFileSync(GATES_LOG, GATES_LAST_LOG);
    }
  } catch {
    // ignore
  }

  run("git", ["reset", "--hard", baseSha]);

  run("git", [
    "clean",
    "-fd",
    "-e",
    ".ai/gates.log",
    "-e",
    ".ai/gates.last.log",
    "-e",
    ".ai/gates.summary.md",
    "-e",
    ".ai/last-output.txt",
    "-e",
    "patch.diff",
    "-e",
    ".ai/PR_BODY.md",
    "-e",
    ".ai/PR_BODY.en.md",
  ]);

  run("git", ["checkout", baseBranch]);

  if (branch && branch !== baseBranch) {
    run("git", ["branch", "-D", branch]);
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readPackageScripts() {
  const pkg = readJsonSafe(path.resolve("package.json"));
  const scripts = pkg && typeof pkg === "object" ? pkg.scripts : null;
  return scripts && typeof scripts === "object" ? scripts : {};
}

function shouldTreatNoTestsAsPass(out) {
  return /No test files found, exiting with code 1/i.test(out);
}

function runGatesCapture() {
  const scripts = readPackageScripts();

  // Gate steps (format steps are conditional)
  const steps = [
    ["pnpm", ["test"]],
    ["pnpm", ["lint"]],
    ["pnpm", ["typecheck"]],
  ];

  // Only run format if scripts exist
  if (typeof scripts.format === "string" && scripts.format.trim()) {
    steps.push(["pnpm", ["format"]]);
  }
  if (
    typeof scripts["format:check"] === "string" &&
    scripts["format:check"].trim()
  ) {
    steps.push(["pnpm", ["format:check"]]);
  }

  let out = "";
  for (const [cmd, args] of steps) {
    const r = run(cmd, args, { capture: true });
    out += `\n$ ${cmd} ${args.join(" ")}\n`;
    out += r.stdout;
    out += r.stderr;

    if (r.status !== 0) {
      // Special case: vitest "No test files found" -> treat as pass
      const combined = `${r.stdout}\n${r.stderr}`;
      if (
        cmd === "pnpm" &&
        args[0] === "test" &&
        shouldTreatNoTestsAsPass(combined)
      ) {
        out += "\n[ai-pr] NOTE: No test files found; treating as PASS.\n";
        continue;
      }
      return { ok: false, log: out, code: r.status };
    }
  }

  return { ok: true, log: out, code: 0 };
}

function main() {
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

  must("git", ["rev-parse", "--is-inside-work-tree"]);

  const baseBranch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const baseSha = capture("git", ["rev-parse", "HEAD"]);

  must("git", ["checkout", "-B", branch, baseSha]);

  if (!fs.existsSync(PATCH_FILE)) {
    console.error(`\n[ai-pr] ${PATCH_FILE} not found.\n`);
    rollback({ baseBranch, baseSha, branch });
    process.exit(2);
  }

  // patch 적용 체크
  const check = run(
    "git",
    ["apply", "--check", "--recount", "--whitespace=nowarn", "-p1", PATCH_FILE],
    { capture: true },
  );

  if (check.status !== 0) {
    writeFileSafe(GATES_LOG, `[git apply --check failed]\n${check.stderr}\n`);
    writeFileSafe(
      GATES_SUMMARY,
      summarizeGates(fs.readFileSync(GATES_LOG, "utf8")),
    );
    rollback({ baseBranch, baseSha, branch });
    process.exit(check.status);
  }

  const apply = run(
    "git",
    ["apply", "--recount", "--whitespace=nowarn", "-p1", PATCH_FILE],
    { capture: true },
  );

  if (apply.status !== 0) {
    writeFileSafe(GATES_LOG, `[git apply failed]\n${apply.stderr}\n`);
    writeFileSafe(
      GATES_SUMMARY,
      summarizeGates(fs.readFileSync(GATES_LOG, "utf8")),
    );
    rollback({ baseBranch, baseSha, branch });
    process.exit(apply.status);
  }

  // 품질 게이트
  const gates = runGatesCapture();
  writeFileSafe(GATES_LOG, gates.log);
  writeFileSafe(GATES_SUMMARY, summarizeGates(gates.log));

  if (!gates.ok) {
    const tail = tailLines(gates.log, 120);
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
  const forcePush = readEnv("AI_FORCE_PUSH") === "1";
  const pushArgs = ["push", "-u", "origin", branch];
  if (forcePush) pushArgs.push("--force-with-lease");
  must("git", pushArgs);

  // IMPORTANT: enforce our AI PR body (no --fill)
  const prArgs = ["pr", "create", "--title", title];
  if (prBody.trim()) {
    prArgs.push("--body", prBody);
  } else {
    // fallback: let gh fill if body missing
    prArgs.push("--fill");
  }

  must("gh", prArgs);

  console.log("\n[ai-pr] done.\n");
}

main();
