import dotenv from "dotenv";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import OpenAI from "openai";

// Load env files (prefer .env.local)
dotenv.config({ path: ".env.local" });
dotenv.config();

const DEFAULT_BUNDLE_PATH = ".ai/PROMPT_BUNDLE.md";
const DEFAULT_TASK_PATH = ".ai/TASK.md";

const PATCH_PATH = "patch.diff";
const PR_BODY_PATH = ".ai/PR_BODY.md";
const PR_BODY_EN_PATH = ".ai/PR_BODY.en.md";
const LAST_OUTPUT_PATH = ".ai/last-output.txt";
const GATES_LOG_PATH = ".ai/gates.log";

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

function readOptionalNumber(name) {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function readString(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

async function rmIfExists(path) {
  try {
    await fs.rm(path, { force: true, recursive: false });
  } catch {
    // ignore
  }
}

async function cleanupArtifacts() {
  await rmIfExists(PATCH_PATH);
  await rmIfExists(PR_BODY_PATH);
  await rmIfExists(PR_BODY_EN_PATH);
  await rmIfExists(LAST_OUTPUT_PATH);
}

function runCheck(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return r.status === 0;
}

function looksLikeUnifiedDiff(diff) {
  const hasDiffGit = /^diff --git /m.test(diff);
  const hasMinus = /^--- /m.test(diff);
  const hasPlus = /^\+\+\+ /m.test(diff);
  const hasHunk = /^@@ /m.test(diff);
  return hasDiffGit && hasMinus && hasPlus && hasHunk;
}

/**
 * Extract all fenced code blocks for a given language and pick the best candidate.
 * - For diff: pick the longest block (most content).
 * - For md: pick the first block (usually fine) but also allow longest fallback.
 */
function extractAllCodeBlocks(text, lang) {
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```", "gm");
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[1].trimEnd());
  }
  return blocks;
}

function pickBestDiff(blocks) {
  if (!blocks.length) return null;
  let best = blocks[0];
  for (const b of blocks) {
    if (b.length > best.length) best = b;
  }
  return best;
}

function pickBestMd(blocks) {
  if (!blocks.length) return null;
  const first = blocks[0];
  let longest = first;
  for (const b of blocks) {
    if (b.length > longest.length) longest = b;
  }
  if (first.length >= 200) return first;
  return longest;
}

/**
 * Parse TASK.md for "Files to create" section.
 * Expected format:
 * ## Files to create
 * - path
 * - path
 */
function parseRequiredFilesFromTask(taskText) {
  const lines = taskText.split("\n");
  const required = [];

  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();

    if (/^##\s+Files to create\s*$/i.test(line)) {
      inSection = true;
      continue;
    }

    // End section when another heading starts
    if (inSection && /^##\s+/.test(line)) break;

    if (!inSection) continue;

    const m = line.match(/^-\s+(.+)$/);
    if (m) required.push(m[1].trim());
  }

  // Normalize: remove accidental markdown bold
  return required.map((p) => p.replace(/\*\*/g, ""));
}

function mustIncludeRequiredFiles(diff, requiredPaths) {
  if (!requiredPaths.length) return;

  const missing = [];
  for (const p of requiredPaths) {
    const header = `diff --git a/${p} b/${p}`;
    if (!diff.includes(header)) missing.push(p);
  }

  if (missing.length) {
    throw new Error(
      `Diff missing required files:\n- ${missing.join("\n- ")}\n` +
        `Regenerate diff including ALL required files exactly at these paths.`,
    );
  }
}

function isUnsupportedTemperatureError(e) {
  const msg =
    e?.message || e?.error?.message || e?.response?.data?.error?.message || "";
  return msg.includes("Unsupported parameter: 'temperature'");
}

async function responsesCreateWithFallback(client, params) {
  try {
    return await client.responses.create(params);
  } catch (e) {
    // temperature 미지원 모델이면 temperature 제거 후 1회 재시도
    if (params.temperature !== undefined && isUnsupportedTemperatureError(e)) {
      const { temperature: _t, ...rest } = params;
      return await client.responses.create(rest);
    }
    throw e;
  }
}

async function translatePrBodyToKorean({ client, model, text }) {
  const instructions = [
    "Translate the given GitHub pull request description into natural Korean.",
    "Keep the Markdown structure and headings as-is.",
    "Do not add new content. Do not remove content.",
    "Preserve code spans/backticks, command names, filenames, and paths exactly.",
    "If English technical terms are widely used (e.g., PR, lint, typecheck), you may keep them.",
  ].join("\n");

  const resp = await responsesCreateWithFallback(client, {
    model,
    instructions,
    input: text,
    // 번역은 temperature 굳이 필요 없음. (모델이 지원하면 넣고 싶으면 env로 분리)
    max_output_tokens: 1200,
    store: false,
  });

  const out = (resp.output_text ?? "").trimEnd();
  return out ? out : text;
}

async function callAgent({
  client,
  model,
  temperature,
  maxOutputTokens,
  bundle,
  task,
  requiredFiles,
  extraRules,
  attempt,
  previousOut,
}) {
  const diffTemplate = [
    "Here is a minimal valid example of a NEW FILE diff. Follow this format exactly:",
    "```diff",
    "diff --git a/src/domain/normalizeInput.ts b/src/domain/normalizeInput.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/src/domain/normalizeInput.ts",
    "@@ -0,0 +1,3 @@",
    "+export function normalizeInput(input: string): string {",
    "+  return input.trim();",
    "+}",
    "```",
    "",
    "Important: Your diff must include `---`, `+++`, and at least one `@@` hunk with real lines.",
    "Do NOT output header-only diffs like index ...e69de29.",
  ].join("\n");

  const requiredFilesRule = requiredFiles.length
    ? [
        "Required files:",
        ...requiredFiles.map((p) => `- ${p}`),
        "Your diff MUST include changes for every required file listed above.",
      ].join("\n")
    : "";

  const baseRules = [
    "You are an agentic coding system that must produce a single-PR sized change.",
    "Return EXACTLY two blocks and nothing else:",
    "1) One unified diff inside a single ```diff code block.",
    "2) One PR body inside a single ```md code block (Summary / How to test / Risk & rollback / Notes).",
    "",
    "Hard requirements for the diff:",
    "- Must be valid `git diff` unified patch format: include `diff --git`, `---`, `+++`, and `@@` hunks.",
    "- Do NOT output header-only diffs. Every changed file must include at least one @@ hunk with real content.",
    "- If creating a new file, use `--- /dev/null` and `+++ b/<path>` and include at least one @@ hunk.",
    "- Hunk headers must match the exact number of lines that follow.",
    "- Every hunk line must start with ' ', '+', '-', or '\\\\' (no whitespace-only lines).",
    "",
    "Constraints:",
    "- Keep changes minimal; no large refactors, no mass formatting.",
    "- Do not add dependencies unless required by the task.",
    "- Changes must pass: pnpm test, pnpm lint, pnpm typecheck, pnpm format:check.",
    '- For Vitest test files, always import: `import { describe, it, expect } from "vitest";`',
    "- Ensure every file is syntactically valid TypeScript (all braces/parens closed).",
    requiredFilesRule,
    diffTemplate,
  ].filter(Boolean);

  const instructions = [...baseRules, ...(extraRules ? [extraRules] : [])].join(
    "\n",
  );

  const inputParts = [
    "# PROMPT_BUNDLE\n",
    bundle,
    "\n\n# TASK\n",
    task,
    "\n\n# ATTEMPT\n",
    String(attempt),
  ];

  if (previousOut) {
    inputParts.push(
      "\n\n# PREVIOUS_INVALID_OUTPUT (for debugging)\n",
      previousOut,
    );
  }

  const input = inputParts.join("");

  const req = {
    model,
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
    store: false,
  };

  // temperature는 모델이 거부할 수 있으니 optional로만 붙임
  if (temperature !== undefined) req.temperature = temperature;

  const response = await responsesCreateWithFallback(client, req);

  const out = response.output_text ?? "";
  await fs.mkdir(".ai", { recursive: true });
  await fs.writeFile(LAST_OUTPUT_PATH, out, "utf8");

  const diffBlocks = extractAllCodeBlocks(out, "diff");
  const mdBlocks = extractAllCodeBlocks(out, "md");

  const diff = pickBestDiff(diffBlocks);
  const prBodyEn = pickBestMd(mdBlocks);

  if (!diff) throw new Error(`No diff block found. See ${LAST_OUTPUT_PATH}`);
  if (!prBodyEn)
    throw new Error(`No md PR body block found. See ${LAST_OUTPUT_PATH}`);

  if (!looksLikeUnifiedDiff(diff)) {
    throw new Error(
      `Invalid unified diff (missing headers or @@ hunk). See ${LAST_OUTPUT_PATH}`,
    );
  }

  // Ensure required files are included in the diff
  mustIncludeRequiredFiles(diff, requiredFiles);

  await fs.writeFile(PATCH_PATH, diff + "\n", "utf8");

  // PR body translation (Option 2)
  await fs.writeFile(PR_BODY_EN_PATH, prBodyEn + "\n", "utf8");

  const translateModel = readString("OPENAI_TRANSLATE_MODEL", model);
  const koBody = await translatePrBodyToKorean({
    client,
    model: translateModel,
    text: prBodyEn,
  });
  await fs.writeFile(PR_BODY_PATH, koBody + "\n", "utf8");

  // Check applicability (more tolerant)
  const ok = runCheck("git", [
    "apply",
    "--check",
    "--recount",
    "--whitespace=nowarn",
    "-p1",
    PATCH_PATH,
  ]);
  if (!ok) {
    throw new Error(
      `Generated patch is not applicable. See ${LAST_OUTPUT_PATH} and ${PATCH_PATH}`,
    );
  }
}

async function readGatesLog() {
  try {
    return await fs.readFile(GATES_LOG_PATH, "utf8");
  } catch {
    return "";
  }
}

function tail(text, lines = 120) {
  const arr = String(text || "").split("\n");
  return arr.slice(-lines).join("\n");
}

async function main() {
  const branch = process.argv[2] ?? "feat/ai-run";
  const commitMsg = process.argv[3] ?? "chore: apply ai patch";

  await cleanupArtifacts();

  console.log("[ai:run] bundling prompt...");
  const bundleRes = spawnSync("pnpm", ["ai:bundle"], { stdio: "inherit" });
  if (bundleRes.status !== 0) process.exit(bundleRes.status ?? 1);

  if (!existsSync(DEFAULT_BUNDLE_PATH))
    throw new Error(`Bundle not found: ${DEFAULT_BUNDLE_PATH}`);
  if (!existsSync(DEFAULT_TASK_PATH))
    throw new Error(`Task file is required: ${DEFAULT_TASK_PATH}`);

  const bundle = await fs.readFile(DEFAULT_BUNDLE_PATH, "utf8");
  const task = (await fs.readFile(DEFAULT_TASK_PATH, "utf8")).trim();
  if (!task) throw new Error(`Task file is empty: ${DEFAULT_TASK_PATH}`);

  const requiredFiles = parseRequiredFilesFromTask(task);

  console.log("[ai:run] calling OpenAI...");
  const client = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });

  const model = readString("OPENAI_MODEL", "gpt-4o-mini");
  const maxOutputTokens = readNumber("OPENAI_MAX_OUTPUT_TOKENS", 2200);
  const temperature = readOptionalNumber("OPENAI_TEMPERATURE"); // gpt-5-mini 대응: 없으면 안 보냄

  let previousOut = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const extraRules =
        attempt === 1
          ? ""
          : [
              "Your previous output was invalid or failed quality gates.",
              "Regenerate a correct unified diff with full headers and at least one @@ hunk per file.",
              "Do not output header-only diffs (e.g., index ...e69de29).",
              "Include ALL required files listed in the instructions.",
              "Fix issues reported in the gates log if provided.",
            ].join(" ");

      await cleanupArtifacts();

      await callAgent({
        client,
        model,
        temperature,
        maxOutputTokens,
        bundle,
        task,
        requiredFiles,
        extraRules,
        attempt,
        previousOut,
      });

      // (1) 먼저 dry-run으로 적용+게이트 통과 여부 확인
      const dry = spawnSync(
        "node",
        ["scripts/ai-pr.mjs", branch, commitMsg, "--dry-run"],
        {
          stdio: "inherit",
          env: { ...process.env, AI_PR_BODY_FILE: PR_BODY_PATH },
        },
      );

      if ((dry.status ?? 1) !== 0) {
        const gatesLog = await readGatesLog();
        const debug = [
          "# DRY_RUN_FAILED_GATES_LOG_TAIL",
          tail(gatesLog, 200),
        ].join("\n");
        // 다음 attempt에 반영되도록 previousOut에 gates log까지 포함
        try {
          const last = await fs.readFile(LAST_OUTPUT_PATH, "utf8");
          previousOut = `${last}\n\n${debug}\n`;
        } catch {
          previousOut = debug;
        }
        if (attempt === 3) {
          throw new Error(`Dry-run failed. See ${GATES_LOG_PATH}`);
        }
        continue;
      }

      // dry-run 통과: 루프 탈출
      break;
    } catch (e) {
      console.error(`[ai:run] attempt ${attempt} failed:`, e?.message || e);

      try {
        const last = await fs.readFile(LAST_OUTPUT_PATH, "utf8");
        previousOut = last;
      } catch {
        // ignore
      }

      if (attempt === 3) throw e;
    }
  }

  console.log(
    `[ai:run] wrote ${PATCH_PATH}, ${PR_BODY_PATH}, ${PR_BODY_EN_PATH}`,
  );
  console.log("[ai:run] applying patch + creating PR...");

  // (2) dry-run 통과한 경우에만 실제 PR 생성
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
