import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import OpenAI from "openai";

// 1) .env.local 우선 로드
dotenv.config({ path: ".env.local" });
// 2) 없을 경우를 대비해 .env도 로드(있으면 덮어쓰지 않음)
dotenv.config();import fs from "node:fs/promises";

const DEFAULT_BUNDLE_PATH = ".ai/PROMPT_BUNDLE.md";
const DEFAULT_TASK_PATH = ".ai/TASK.md";
const PATCH_PATH = "patch.diff";
const PR_BODY_PATH = ".ai/PR_BODY.md";
const LAST_OUTPUT_PATH = ".ai/last-output.txt";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function readNumber(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function extractCodeBlock(text, lang) {
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```", "m");
  const m = text.match(re);
  return m ? m[1].trimEnd() : null;
}

async function main() {
  const branch = process.argv[2] ?? "feat/ai-run";
  const commitMsg = process.argv[3] ?? "chore: apply ai patch";

  // 1) bundle 생성(있다면 스킵해도 되지만, 기본은 생성)
  console.log("[ai:run] bundling prompt...");
  const bundleRes = spawnSync("pnpm", ["ai:bundle"], { stdio: "inherit" });
  if (bundleRes.status !== 0) process.exit(bundleRes.status);

  if (!existsSync(DEFAULT_BUNDLE_PATH)) {
    throw new Error(`Bundle not found: ${DEFAULT_BUNDLE_PATH}`);
  }

  // TASK는 선택(없으면 빈 문자열)
  const bundle = await fs.readFile(DEFAULT_BUNDLE_PATH, "utf8");
  const task = existsSync(DEFAULT_TASK_PATH)
    ? await fs.readFile(DEFAULT_TASK_PATH, "utf8")
    : "";

  // 2) OpenAI 호출
  console.log("[ai:run] calling OpenAI...");
  const client = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const maxOutputTokens = readNumber("OPENAI_MAX_OUTPUT_TOKENS", 1800);
  const temperature = readNumber("OPENAI_TEMPERATURE", 0.2);

  const instructions = [
    "You are an agentic coding system that must produce a single-PR sized change.",
    "Return EXACTLY two blocks:",
    "1) One unified diff inside a single ```diff code block.",
    "2) One PR body inside a single ```md code block (Summary / How to test / Risk & rollback / Notes).",
    "Do not include any other text outside those two code blocks.",
    "Do not add new dependencies unless explicitly required by the task/bundle.",
    "Do not do large refactors or mass formatting; keep changes minimal.",
    "All changes must pass: pnpm test, pnpm lint, pnpm typecheck, pnpm format:check.",
  ].join("\n");

  const input = [
    "# PROMPT_BUNDLE\n",
    bundle,
    "\n\n# TASK\n",
    task || "(no task file)",
  ].join("");

  const response = await client.responses.create({
    model,
    instructions,
    input,
    temperature,
    max_output_tokens: maxOutputTokens,
    store: false,
  });

  const out = response.output_text ?? "";
  await fs.mkdir(".ai", { recursive: true });
  await fs.writeFile(LAST_OUTPUT_PATH, out, "utf8");

  const diff = extractCodeBlock(out, "diff");
  const prBody = extractCodeBlock(out, "md");

  if (!diff) {
    throw new Error(`No diff block found. See ${LAST_OUTPUT_PATH}`);
  }
  if (!prBody) {
    throw new Error(`No md PR body block found. See ${LAST_OUTPUT_PATH}`);
  }

  await fs.writeFile(PATCH_PATH, diff + "\n", "utf8");
  await fs.writeFile(PR_BODY_PATH, prBody + "\n", "utf8");

  console.log(`[ai:run] wrote ${PATCH_PATH} and ${PR_BODY_PATH}`);

  // 3) ai-pr 실행(브랜치/커밋/푸시/PR)
  // ai-pr가 PR 본문 파일을 읽도록 env로 전달
  console.log("[ai:run] applying patch + creating PR...");
  const prRes = spawnSync("node", ["scripts/ai-pr.mjs", branch, commitMsg], {
    stdio: "inherit",
    env: { ...process.env, AI_PR_BODY_FILE: PR_BODY_PATH },
  });

  process.exit(prRes.status ?? 1);
}

main().catch((e) => {
  console.error("[ai:run] failed:", e?.message || e);
  process.exit(1);
});
