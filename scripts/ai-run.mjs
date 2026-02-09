import dotenv from "dotenv";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

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

const OPENAI_BASE_URL = "https://api.openai.com/v1";

// -----------------------------
// Utils
// -----------------------------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return String(v);
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

function runCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function looksLikeUnifiedDiff(diff) {
  const hasDiffGit = /^diff --git /m.test(diff);
  const hasMinus = /^--- /m.test(diff);
  const hasPlus = /^\+\+\+ /m.test(diff);
  const hasHunk = /^@@ /m.test(diff);
  return hasDiffGit && hasMinus && hasPlus && hasHunk;
}

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
  for (const b of blocks) if (b.length > best.length) best = b;
  return best;
}

function pickBestMd(blocks) {
  if (!blocks.length) return null;
  const first = blocks[0];
  let longest = first;
  for (const b of blocks) if (b.length > longest.length) longest = b;
  return first.length >= 200 ? first : longest;
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
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;

    const m = line.match(/^-\s+(.+)$/);
    if (m) required.push(m[1].trim());
  }

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

// -----------------------------
// Policy / Forbidden guards
// -----------------------------
function assertPatchPolicy({
  diff,
  repoUsesVitestMts = true,
  forbidReactTestingLib = true,
  forbidAppDraftsTests = true,
}) {
  // 1) vitest config 중복/변형 방지
  const forbiddenVitestConfigs = [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.cjs",
    "vitest.config.mjs",
  ];

  if (repoUsesVitestMts) {
    for (const f of forbiddenVitestConfigs) {
      const re = new RegExp(
        `^diff --git a/${f.replace(/\./g, "\\.")} b/${f.replace(/\./g, "\\.")}$`,
        "m",
      );
      if (re.test(diff)) {
        throw new Error(
          `Policy violation: forbidden change detected: ${f} (repo already uses vitest.config.mts)`,
        );
      }
    }
  }

  // 2) app/drafts/** 테스트 추가 금지
  if (forbidAppDraftsTests) {
    const re =
      /^diff --git a\/app\/drafts\/.*__tests__\/.* b\/app\/drafts\/.*__tests__\/.*/m;
    if (re.test(diff)) {
      throw new Error(
        `Policy violation: tests under app/drafts/**/__tests__ are not allowed (breaks typecheck/lint due to missing deps).`,
      );
    }
  }

  // 3) Testing Library import 금지
  if (forbidReactTestingLib) {
    const re = /@testing-library\/react/;
    if (re.test(diff)) {
      throw new Error(
        `Policy violation: patch introduces @testing-library/react but repo doesn't include it.`,
      );
    }
  }

  // 4) package.json 변경 금지 (Task가 허용할 때만)
  const pkgRe = /^diff --git a\/package\.json b\/package\.json/m;
  if (pkgRe.test(diff)) {
    throw new Error(
      `Policy violation: patch modifies package.json. Keep dependencies unchanged unless TASK explicitly allows.`,
    );
  }
}

const FORBIDDEN_DIFF_PATTERNS = [
  {
    re: /@testing-library\/react/,
    message:
      "Do NOT introduce @testing-library/react. Repo does not have it and typecheck will fail.",
  },
  {
    re: /@testing-library\/jest-dom/,
    message:
      "Do NOT introduce @testing-library/jest-dom. Repo does not have it and typecheck will fail.",
  },
  {
    re: /\btoBeInTheDocument\b/,
    message:
      "Do NOT use toBeInTheDocument (jest-dom matcher). Use basic expect(...) only.",
  },
  {
    re: /^diff --git a\/app\/.*\/__tests__\/.* b\/app\/.*\/__tests__\/.*/m,
    message:
      "Do NOT create tests under app/**/__tests__. Put tests under src/__tests__ instead.",
  },
  {
    re: /^diff --git a\/vitest\.config\.(ts|js|cjs|mjs) b\/vitest\.config\.(ts|js|cjs|mjs)$/m,
    message:
      "Do NOT create/modify vitest.config.ts/js/cjs/mjs. This repo uses vitest.config.mts (or existing config).",
  },
  {
    re: /^diff --git a\/vitest\.setup\.ts b\/vitest\.setup\.ts$/m,
    message:
      "Do NOT add vitest.setup.ts unless an existing vitest config already references it.",
  },
];

function assertNoForbiddenDiff(diff) {
  for (const p of FORBIDDEN_DIFF_PATTERNS) {
    if (p.re.test(diff)) {
      throw new Error(`Forbidden diff content detected: ${p.message}`);
    }
  }
}

function assertDoNotTouchUnlessTask({ diff, taskText, allowedPaths }) {
  // 보호 파일: 코더가 괜히 건드리면 patch apply conflict / 의미 없는 변경이 자주 발생
  const protectedPaths = [
    "src/__tests__/smoke.test.ts",
    "app/page.tsx", // ✅ 홈 페이지 절대 금지
    "app/layout.tsx", // ✅ 레이아웃도 절대 금지(대부분 TASK 범위 밖)
  ];

  for (const p of protectedPaths) {
    const header = `diff --git a/${p} b/${p}`;
    if (!diff.includes(header)) continue;

    const mentionedInTask = taskText.includes(p);
    const allowed = allowedPaths.includes(p);

    if (!mentionedInTask && !allowed) {
      throw new Error(
        `Do NOT modify ${p} unless TASK explicitly asks for it. Regenerate diff without touching ${p}.`,
      );
    }
  }
}

function assertNoDuplicateFileDiffs(diff) {
  const re = /^diff --git a\/(.+?) b\/\1$/gm;
  const seen = new Set();
  const dups = new Set();
  let m;
  while ((m = re.exec(diff)) !== null) {
    const p = m[1];
    if (seen.has(p)) dups.add(p);
    seen.add(p);
  }
  if (dups.size) {
    throw new Error(
      `Duplicate diff blocks detected for files:\n- ${[...dups].join("\n- ")}\n` +
        `Regenerate diff with EXACTLY one diff block per file.`,
    );
  }
}

// -----------------------------
// Anthropic API (Fix/Review only)
// -----------------------------
async function anthropicMessagesCreate({
  apiKey,
  model,
  system,
  userText,
  maxTokens,
  temperature,
}) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: userText }],
  };

  if (system && String(system).trim()) body.system = system;
  if (temperature !== undefined) body.temperature = temperature;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || JSON.stringify(json);
    throw new Error(
      `Anthropic API error: ${res.status} ${res.statusText} - ${msg}`,
    );
  }

  const parts = Array.isArray(json?.content) ? json.content : [];
  const text = parts
    .filter((p) => p && p.type === "text")
    .map((p) => p.text)
    .join("");

  return String(text || "");
}

// -----------------------------
// OpenAI API (Code + Translate)
// -----------------------------
async function openaiResponsesCreate({
  apiKey,
  model,
  system,
  userText,
  maxTokens,
  temperature,
}) {
  // ✅ Responses API 포맷: input은 "문자열" 또는 "input array of items"
  // 가장 호환 좋은 방식: system+user를 하나의 문자열로 합쳐서 input에 넣기
  const merged = [
    system && String(system).trim() ? `SYSTEM:\n${String(system).trim()}` : "",
    `USER:\n${String(userText || "")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const body = {
    model,
    input: merged,
    store: false,
  };

  if (typeof maxTokens === "number") body.max_output_tokens = maxTokens;
  if (typeof temperature === "number") body.temperature = temperature;

  const res = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      json?.error?.message || json?.message || JSON.stringify(json || {});
    throw new Error(
      `OpenAI API error: ${res.status} ${res.statusText} - ${msg}`,
    );
  }

  const out =
    typeof json?.output_text === "string"
      ? json.output_text
      : typeof json?.response?.output_text === "string"
        ? json.response.output_text
        : "";

  return String(out || "");
}

async function translatePrBodyToKorean({ model, text }) {
  const instructions = [
    "Translate the given GitHub pull request description into natural Korean.",
    "Keep the Markdown structure and headings as-is.",
    "Do not add new content. Do not remove content.",
    "Preserve code spans/backticks, command names, filenames, and paths exactly.",
    "Return ONLY the translated Markdown. No extra commentary.",
  ].join("\n");

  const out = (
    await openaiResponsesCreate({
      apiKey: mustEnv("OPENAI_API_KEY"),
      model,
      system: instructions,
      userText: text,
      maxTokens: 1200,
      temperature: undefined,
    })
  ).trimEnd();

  return out ? out : text;
}

async function callAgent({
  provider, // "openai" | "anthropic"
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
    "Do not output any text outside the two fenced code blocks.",
    "",
    "Hard requirements for the diff:",
    "- Must be valid `git diff` unified patch format: include `diff --git`, `---`, `+++`, and `@@` hunks.",
    "- Do NOT output header-only diffs. Every changed file must include at least one @@ hunk with real content.",
    "- If creating a new file, use `--- /dev/null` and `+++ b/<path>` and include at least one @@ hunk.",
    "",
    "Constraints:",
    "- Keep changes minimal; no large refactors, no mass formatting.",
    "- Do not add dependencies unless required by the task.",
    "- Changes must pass: pnpm test, pnpm lint, pnpm typecheck, pnpm format:check.",
    "- Avoid `any` (eslint no-explicit-any). Use unknown + narrowing if needed.",
    "",
    "Testing constraints (IMPORTANT):",
    "- Do NOT use @testing-library/react or jest-dom matchers.",
    "- Do NOT create tests under app/**/__tests__.",
    '- For Vitest test files, always import: `import { describe, it, expect } from "vitest";`',
    "",
    "Repo invariants:",
    "- Never modify app/page.tsx or app/layout.tsx unless TASK explicitly asks.",
    "- Implement Create New Draft page ONLY at: app/drafts/new/page.tsx (or paths explicitly requested by TASK).",
    "- Do NOT create or modify any vitest config files unless TASK explicitly asks.",
    "- If vitest.config.mts exists, NEVER create vitest.config.ts/js/cjs/mjs.",
    "- Never add vitest.setup.ts unless referenced by existing config.",
    "- Do NOT modify src/__tests__/smoke.test.ts unless TASK explicitly asks.",
    "",
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

  const userText = inputParts.join("");
  let out = "";

  if (provider === "openai") {
    out = await openaiResponsesCreate({
      apiKey: mustEnv("OPENAI_API_KEY"),
      model,
      system: instructions,
      userText,
      maxTokens: maxOutputTokens,
      temperature,
    });
  } else {
    out = await anthropicMessagesCreate({
      apiKey: mustEnv("ANTHROPIC_API_KEY"),
      model,
      system: instructions,
      userText,
      maxTokens: maxOutputTokens,
      temperature,
    });
  }

  await fs.mkdir(".ai", { recursive: true });
  await fs.writeFile(LAST_OUTPUT_PATH, out, "utf8");

  const diffBlocks = extractAllCodeBlocks(out, "diff");
  const mdBlocks = [
    ...extractAllCodeBlocks(out, "md"),
    ...extractAllCodeBlocks(out, "markdown"),
    ...extractAllCodeBlocks(out, "mdx"),
  ];

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

  // required files
  mustIncludeRequiredFiles(diff, requiredFiles);

  // hard guards
  assertNoForbiddenDiff(diff);
  assertDoNotTouchUnlessTask({
    diff,
    taskText: task,
    allowedPaths: requiredFiles,
  });
  assertNoDuplicateFileDiffs(diff);

  // policy gate
  assertPatchPolicy({
    diff,
    repoUsesVitestMts: existsSync("vitest.config.mts"),
    forbidReactTestingLib: true,
    forbidAppDraftsTests: true,
  });

  await fs.writeFile(PATCH_PATH, diff + "\n", "utf8");
  await fs.writeFile(PR_BODY_EN_PATH, prBodyEn + "\n", "utf8");

  // translate PR body (OpenAI only)
  const translateModel = readString("OPENAI_TRANSLATE_MODEL", "gpt-5.2");
  const koBody = await translatePrBodyToKorean({
    model: translateModel,
    text: prBodyEn,
  });
  await fs.writeFile(PR_BODY_PATH, koBody + "\n", "utf8");

  // check patch applicability
  const chk = runCapture("git", [
    "apply",
    "--check",
    "--recount",
    "--whitespace=nowarn",
    "-p1",
    PATCH_PATH,
  ]);

  if (chk.status !== 0) {
    const debug = `\n\n# GIT_APPLY_CHECK_FAILED\n${chk.stderr}\n`;
    await fs.writeFile(LAST_OUTPUT_PATH, out + debug, "utf8");
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

function tail(text, lines = 160) {
  const arr = String(text || "").split("\n");
  return arr.slice(-lines).join("\n");
}

async function main() {
  const defaultBranch = `feat/ai-run-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  const branch = process.argv[2] ?? process.env.AI_BRANCH ?? defaultBranch;
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

  // Models
  const openaiModel = readString("OPENAI_MODEL", "gpt-5.2");
  const claudeModel = readString("ANTHROPIC_MODEL", "claude-sonnet-4-5");

  // Knobs (shared)
  const maxOutputTokens = readNumber("AI_MAX_OUTPUT_TOKENS", 2400);
  const temperature = readOptionalNumber("AI_TEMPERATURE");

  let previousOut = "";
  let success = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // attempt 1: OpenAI (code). attempt 2-3: Anthropic (fix/review)
      const provider = attempt === 1 ? "openai" : "anthropic";
      const model = provider === "openai" ? openaiModel : claudeModel;

      if (provider === "openai") {
        console.log("[ai:run] calling OpenAI (code)...");
        mustEnv("OPENAI_API_KEY");
      } else {
        console.log("[ai:run] calling Claude (Anthropic) for fix/review...");
        mustEnv("ANTHROPIC_API_KEY");
      }

      const extraRules =
        attempt === 1
          ? ""
          : [
              "Your previous output was invalid or failed quality gates.",
              "Regenerate a correct unified diff with full headers and at least one @@ hunk per file.",
              "Do not output header-only diffs (e.g., index ...e69de29).",
              "Fix issues reported in the gates log if provided.",
              "Reminder: no @testing-library/*, no toBeInTheDocument, no app/**/__tests__.",
              "Reminder: Do NOT modify app/page.tsx or app/layout.tsx.",
            ].join(" ");

      await cleanupArtifacts();

      await callAgent({
        provider,
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

      // dry-run gates
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
          tail(gatesLog, 220),
        ].join("\n");

        try {
          const last = await fs.readFile(LAST_OUTPUT_PATH, "utf8");
          previousOut = `${last}\n\n${debug}\n`;
        } catch {
          previousOut = debug;
        }

        if (attempt === 3)
          throw new Error(`Dry-run failed. See ${GATES_LOG_PATH}`);
        continue;
      }

      success = true;
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

  if (!success) {
    throw new Error(
      `[ai:run] failed: could not generate a valid diff+md after 3 attempts. See ${LAST_OUTPUT_PATH}`,
    );
  }

  console.log(
    `[ai:run] wrote ${PATCH_PATH}, ${PR_BODY_PATH}, ${PR_BODY_EN_PATH}`,
  );
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
