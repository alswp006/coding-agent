import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const QUEUE_FILE = ".ai/queue.json";
const STATE_FILE = ".ai/queue.state.json";

function readJsonSafe(p) {
  if (!existsSync(p)) return null;
  return fs.readFile(p, "utf8").then((s) => JSON.parse(s));
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: env ?? process.env });
  return r.status === 0;
}

function sanitizeBranchName(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_/]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const queue = await readJsonSafe(QUEUE_FILE);
  if (!queue || !Array.isArray(queue.items)) {
    throw new Error(`Invalid queue file: ${QUEUE_FILE}`);
  }

  const state = (await readJsonSafe(STATE_FILE)) ?? { cursor: 0 };
  const cursor = Number.isFinite(state.cursor) ? state.cursor : 0;

  if (cursor >= queue.items.length) {
    console.log(`[ai:next] done. cursor=${cursor}, items=${queue.items.length}`);
    return;
  }

  const wpPath = queue.items[cursor];
  if (typeof wpPath !== "string" || !wpPath.trim()) {
    throw new Error(`Invalid queue item at index ${cursor}`);
  }

  console.log(`[ai:next] cursor=${cursor} work-packet=${wpPath}`);

  // 1) TASK 생성
  const okTask = run("node", ["scripts/wp-to-task.mjs", wpPath, ".ai/TASK.md"]);
  if (!okTask) throw new Error("wp-to-task failed");

  // 2) PR 생성 (ai-run.mjs)
  // branch/commit 메시지는 work-packet 파일명 기준으로 자동 생성
  const base = path.basename(wpPath).replace(/\.json$/i, "");
  const branch = sanitizeBranchName(`feat/wp-${base}`);
  const commitMsg = `feat: implement ${base}`;

  const okRun = run("node", ["scripts/ai-run.mjs", branch, commitMsg], {
    ...process.env,
  });
  if (!okRun) throw new Error("ai-run failed");

  // 3) cursor++ (로컬 상태만 업데이트)
  const nextState = { cursor: cursor + 1, last: wpPath, updated_at: new Date().toISOString() };
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(nextState, null, 2) + "\n", "utf8");

  console.log(`[ai:next] success. cursor -> ${cursor + 1}`);
  console.log(`[ai:next] state saved: ${STATE_FILE}`);
}

main().catch((e) => {
  console.error("[ai:next] failed:", e?.message || e);
  process.exit(1);
});
