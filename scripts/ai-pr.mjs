import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const branch = process.argv[2] || `feat/ai-${Date.now()}`;
const title = process.argv[3] || "chore: ai change";
const body = process.argv[4] || "";

console.log(`\n[ai-pr] branch: ${branch}\n`);

run("git", ["rev-parse", "--is-inside-work-tree"]);
run("git", ["checkout", "-b", branch]);

if (!fs.existsSync("patch.diff")) {
  console.error(
    "\n[ai-pr] patch.diff not found. Put unified diff into patch.diff first.\n",
  );
  process.exit(2);
}

console.log("\n[ai-pr] applying patch.diff ...\n");
run("git", ["apply", "-p0", "patch.diff"]);

console.log("\n[ai-pr] running quality gates ...\n");
run("pnpm", ["test"]);
run("pnpm", ["lint"]);
run("pnpm", ["typecheck"]);
run("pnpm", ["format:check"]);

console.log("\n[ai-pr] committing ...\n");
run("git", ["add", "-A"]);
run("git", ["commit", "-m", title]);

console.log("\n[ai-pr] pushing ...\n");
run("git", ["push", "-u", "origin", branch]);

console.log("\n[ai-pr] creating PR ...\n");

// 우선순위: (1) AI_PR_BODY_FILE (2) argv body (3) --fill
const prArgs = ["pr", "create", "--title", title];

const prBodyFile = process.env.AI_PR_BODY_FILE;
const hasBodyFile = prBodyFile && fs.existsSync(prBodyFile);

if (hasBodyFile) {
  prArgs.push("--body-file", prBodyFile);
} else if (body) {
  prArgs.push("--body", body);
} else {
  prArgs.push("--fill");
}

run("gh", prArgs);

console.log("\n[ai-pr] done.\n");
