import dotenv from "dotenv";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
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

async function rmIfExists(p) {
  try {
    await fs.rm(p, { force: true, recursive: false });
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

// ─────────────────────────────────────────────────────────────
// ★ NEW: Salvage parser — extract diff even without fenced blocks
// ─────────────────────────────────────────────────────────────

/**
 * Try multiple strategies to extract a unified diff from raw model output.
 * Returns the best diff string found, or null.
 */
function salvageDiff(rawOutput) {
  // Strategy 1: standard fenced ```diff blocks
  const fencedDiff = extractAllCodeBlocks(rawOutput, "diff");
  if (fencedDiff.length) {
    const best = pickBestDiff(fencedDiff);
    if (best && looksLikeUnifiedDiff(best)) return best;
  }

  // Strategy 2: fenced blocks with other lang tags that contain diff content
  // e.g. ```patch, ```text, ```shell, ```plaintext, ```, ```unified
  const anyFenced = extractAllCodeBlocks(rawOutput, "[a-zA-Z]*");
  for (const block of anyFenced) {
    if (looksLikeUnifiedDiff(block)) return block;
  }

  // Strategy 2b: bare fenced blocks (``` with no lang tag)
  const bareFenced = [];
  const bareRe = /```\n([\s\S]*?)\n```/gm;
  let bm;
  while ((bm = bareRe.exec(rawOutput)) !== null) {
    bareFenced.push(bm[1].trimEnd());
  }
  for (const block of bareFenced) {
    if (looksLikeUnifiedDiff(block)) return block;
  }

  // Strategy 3: raw unfenced diff — find "diff --git" and collect until end or next prose
  const lines = rawOutput.split("\n");
  let diffStart = -1;
  let diffEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) {
      if (diffStart === -1) diffStart = i;
      diffEnd = i;
    } else if (diffStart !== -1) {
      // Continue collecting diff-related lines
      const l = lines[i];
      if (
        l.startsWith("--- ") ||
        l.startsWith("+++ ") ||
        l.startsWith("@@ ") ||
        l.startsWith("+") ||
        l.startsWith("-") ||
        l.startsWith(" ") ||
        l.startsWith("index ") ||
        l.startsWith("new file mode") ||
        l.startsWith("deleted file mode") ||
        l.startsWith("old mode") ||
        l.startsWith("new mode") ||
        l.startsWith("rename from") ||
        l.startsWith("rename to") ||
        l.startsWith("similarity index") ||
        l.startsWith("Binary files") ||
        l === "" ||
        l === "\\ No newline at end of file"
      ) {
        diffEnd = i;
      } else {
        // Possibly prose or explanation — stop if we've accumulated enough
        // But peek ahead: if another "diff --git" comes soon, keep going
        let nextDiff = -1;
        for (let j = i; j < Math.min(i + 5, lines.length); j++) {
          if (lines[j].startsWith("diff --git ")) {
            nextDiff = j;
            break;
          }
        }
        if (nextDiff === -1) break;
        // skip intervening prose
      }
    }
  }

  if (diffStart !== -1 && diffEnd > diffStart) {
    const extracted = lines.slice(diffStart, diffEnd + 1).join("\n");
    if (looksLikeUnifiedDiff(extracted)) return extracted;
  }

  return null;
}

/**
 * Try multiple strategies to extract a PR body (markdown) from raw model output.
 * Returns the best markdown string found, or a generated placeholder.
 */
function salvagePrBody(rawOutput, task) {
  // Strategy 1: standard fenced ```md / ```markdown / ```mdx blocks
  const mdBlocks = [
    ...extractAllCodeBlocks(rawOutput, "md"),
    ...extractAllCodeBlocks(rawOutput, "markdown"),
    ...extractAllCodeBlocks(rawOutput, "mdx"),
  ];
  const best = pickBestMd(mdBlocks);
  if (best) return best;

  // Strategy 2: look for PR-body-like headings in the raw text
  const headingPatterns = [
    /^#{1,3}\s*Summary/im,
    /^#{1,3}\s*How to test/im,
    /^#{1,3}\s*Description/im,
    /^#{1,3}\s*Changes/im,
    /^#{1,3}\s*What/im,
  ];

  for (const pat of headingPatterns) {
    const match = rawOutput.match(pat);
    if (match) {
      const idx = rawOutput.indexOf(match[0]);
      // Extract from heading to the end of text or next diff block
      let endIdx = rawOutput.length;
      const nextDiff = rawOutput.indexOf("diff --git", idx);
      const nextFence = rawOutput.indexOf("```", idx + 10);
      if (nextDiff > idx) endIdx = Math.min(endIdx, nextDiff);
      if (nextFence > idx) endIdx = Math.min(endIdx, nextFence);
      const section = rawOutput.slice(idx, endIdx).trim();
      if (section.length > 50) return section;
    }
  }

  // Strategy 3: generate a minimal placeholder from task
  const taskFirstLine = (task || "AI-generated changes")
    .split("\n")
    .find((l) => l.trim())
    ?.trim()
    ?.slice(0, 120);
  return [
    "## Summary",
    "",
    taskFirstLine || "Apply changes as specified in TASK.",
    "",
    "## How to test",
    "",
    "- `pnpm test`",
    "- `pnpm typecheck`",
    "",
    "## Risk & rollback",
    "",
    "Low risk. Revert the PR commit.",
    "",
    "## Notes",
    "",
    "PR body auto-generated (model output did not include a proper md block).",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// ★ NEW: OpenAI format-repair retry
// ─────────────────────────────────────────────────────────────

/**
 * If OpenAI's output failed parsing, send a repair prompt to OpenAI
 * with the bad output, asking it to re-emit just the two code blocks.
 * Returns the repaired output text, or null if repair also fails.
 */
async function openaiFormatRepair({
  apiKey,
  model,
  badOutput,
  maxTokens,
}) {
  const repairPrompt = [
    "Your previous output did not follow the required format.",
    "I need EXACTLY two fenced code blocks and nothing else:",
    "",
    "1) A ```diff block containing a valid unified diff (git diff format).",
    "2) A ```md block containing the PR body in Markdown.",
    "",
    "No explanations, no extra text outside the two blocks.",
    "",
    "Here is your previous output. Extract and re-format it correctly:",
    "",
    "---BEGIN PREVIOUS OUTPUT---",
    badOutput.slice(0, 12000), // limit to avoid token overflow
    "---END PREVIOUS OUTPUT---",
    "",
    "Now output ONLY the two fenced code blocks (```diff and ```md).",
  ].join("\n");

  try {
    console.log("[ai:run] attempting OpenAI format-repair...");
    const repaired = await openaiResponsesCreate({
      apiKey,
      model,
      system:
        "You are a formatting assistant. Re-emit the user's content as exactly two fenced code blocks: one ```diff and one ```md. No extra text.",
      userText: repairPrompt,
      maxTokens,
    });
    return repaired || null;
  } catch (e) {
    console.warn("[ai:run] format-repair call failed:", e?.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// ★ NEW: Patch auto-fix — try --recount, fuzzy, and strip whitespace
// ─────────────────────────────────────────────────────────────

/**
 * Try progressively more lenient git apply strategies.
 * Returns { ok: boolean, stderr: string }.
 */
function tryGitApply(patchPath) {
  // Attempt 1: normal (with --recount)
  const strategies = [
    ["--check", "--recount", "--whitespace=nowarn", "-p1"],
    ["--check", "--recount", "--whitespace=fix", "-p1"],
    ["--check", "--recount", "--whitespace=nowarn", "-p1", "-C1"],  // reduce context requirement
  ];

  for (const args of strategies) {
    const chk = runCapture("git", ["apply", ...args, patchPath]);
    if (chk.status === 0) return { ok: true, stderr: "" };
  }

  // Return the last error for diagnosis
  const lastCheck = runCapture("git", [
    "apply",
    "--check",
    "--recount",
    "--whitespace=nowarn",
    "-p1",
    patchPath,
  ]);
  return { ok: false, stderr: lastCheck.stderr };
}

// ─────────────────────────────────────────────────────────────

function pickBestDiff(blocks) {
  if (!blocks.length) return null;
  // 가장 긴 diff를 선택 (대체로 완성본일 확률 높음)
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
        `Policy violation: tests under app/drafts/**/__tests__ are not allowed.`,
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
      "Do NOT create tests under app/**/__tests__. Put tests under src/**/__tests__ instead.",
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
  const protectedPaths = ["src/__tests__/smoke.test.ts"];

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

// -----------------------------
// Repo snapshot helpers (patch applicability booster)
// -----------------------------

async function safeReadFile(p, maxBytes = 40_000) {
  try {
    const buf = await fs.readFile(p);
    if (buf.length > maxBytes) {
      return buf.slice(0, maxBytes).toString("utf8") + "\n\n[TRUNCATED]\n";
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function isProbablyTextFile(p) {
  const ext = path.extname(p).toLowerCase();
  // 필요한 확장만 선별 (너무 많이 넣으면 프롬프트 비대화)
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mts",
    ".cts",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".css",
  ].includes(ext);
}

async function buildRepoSnapshot(requiredFiles) {
  // "패치 적용성"에 직접 영향 큰 파일을 우선 제공
  const candidates = new Set([
    "app/page.tsx",
    "app/layout.tsx",
    "app/drafts/new/page.tsx",
    "src/domain/draft.ts",
    "src/domain/buildDraftState.ts",
    "src/domain/draftForm.ts",
    "src/domain/draftFieldNames.ts",
    "src/domain/__tests__/draft.test.ts",
    "src/domain/__tests__/buildDraftState.test.ts",
    "src/__tests__/smoke.test.ts",
    "package.json",
    "tsconfig.json",
    "vitest.config.mts",
  ]);

  for (const p of requiredFiles) candidates.add(p);

  const parts = [];
  for (const p of Array.from(candidates)) {
    if (!existsSync(p)) continue;
    if (!isProbablyTextFile(p)) continue;
    const content = await safeReadFile(p);
    if (!content) continue;
    parts.push(`## FILE: ${p}\n\`\`\`\n${content.trimEnd()}\n\`\`\``);
  }

  return parts.length ? parts.join("\n\n") : "(no snapshot files captured)";
}

function parseFailedPathsFromGitApply(stderrText) {
  const s = String(stderrText || "");
  const paths = new Set();

  // 대표 케이스:
  // "error: patch failed: app/page.tsx:1"
  // "error: app/page.tsx: patch does not apply"
  const re1 = /patch failed:\s+([^\s:]+):\d+/g;
  const re2 = /error:\s+([^\s:]+):\s+patch does not apply/g;

  let m;
  while ((m = re1.exec(s)) !== null) paths.add(m[1]);
  while ((m = re2.exec(s)) !== null) paths.add(m[1]);

  return Array.from(paths);
}

async function buildFailureSnapshot(failedPaths) {
  const parts = [];
  for (const p of failedPaths) {
    if (!p) continue;
    if (!existsSync(p)) continue;
    const content = await safeReadFile(p, 80_000);
    if (!content) continue;
    parts.push(`## FAILED_FILE: ${p}\n\`\`\`\n${content.trimEnd()}\n\`\`\``);
  }
  return parts.length ? parts.join("\n\n") : "";
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
}) {
  const body = {
    model,
    input: [
      ...(system && String(system).trim()
        ? [{ role: "system", content: String(system) }]
        : []),
      { role: "user", content: String(userText || "") },
    ],
  };

  // ★ temperature를 절대 보내지 않음 — 일부 OpenAI 모델(o1, o3 등)이 400을 냄
  // max_output_tokens도 모델별로 조심
  if (typeof maxTokens === "number") body.max_output_tokens = maxTokens;

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

  const output = Array.isArray(json?.output) ? json.output : [];
  const text = output
    .flatMap((o) => (Array.isArray(o?.content) ? o.content : []))
    .filter((c) => c && c.type === "output_text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");

  const fallbackText =
    typeof json?.output_text === "string" ? json.output_text : "";

  return String(text || fallbackText || "");
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
  repoSnapshot,
  failureSnapshot,
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
    "Important:",
    "- Output ONE diff block only. Do NOT repeat files or include duplicate diff sections.",
    "- Each changed file must include `---`, `+++`, and at least one `@@` hunk with real lines.",
  ].join("\n");

  const requiredFilesRule = requiredFiles.length
    ? [
        "Required files:",
        ...requiredFiles.map((p) => `- ${p}`),
        "Your diff MUST include changes for every required file listed above.",
      ].join("\n")
    : "";

  // ★ OpenAI-specific format reinforcement (더 강하게 제약)
  const formatReinforcement =
    provider === "openai"
      ? [
          "",
          "CRITICAL FORMAT RULES (you MUST follow these exactly):",
          "- Your entire response must contain EXACTLY two fenced code blocks.",
          '- The first block MUST start with ```diff and end with ```',
          '- The second block MUST start with ```md and end with ```',
          "- Do NOT output ANY text before the first ``` or after the last ```.",
          "- Do NOT use ```patch, ```text, ```shell, or any other language tag for the diff.",
          "- Do NOT output the diff as plain text without fences.",
          "",
        ].join("\n")
      : "";

  const baseRules = [
    "You are an agentic coding system that must produce a single-PR sized change.",
    "Return EXACTLY two blocks and nothing else:",
    "1) One unified diff inside a single ```diff code block.",
    "2) One PR body inside a single ```md code block (Summary / How to test / Risk & rollback / Notes).",
    "Do not output any text outside the two fenced code blocks.",
    formatReinforcement,
    "Hard requirements for the diff:",
    "- Must be valid `git diff` unified patch format: include `diff --git`, `---`, `+++`, and `@@` hunks.",
    "- Output ONE diff block only. No duplicate `diff --git` for same file.",
    "- Do NOT delete+recreate the same file in two separate diff entries.",
    "- Prefer small, minimal hunks. Do NOT replace entire files unless TASK requires.",
    "- Context lines in the diff MUST exactly match the REPO_SNAPSHOT files provided below.",
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
    "\n\n# REPO_SNAPSHOT (current files; generate diffs against this)\n",
    repoSnapshot || "(no snapshot)",
  ];

  if (failureSnapshot && String(failureSnapshot).trim()) {
    inputParts.push(
      "\n\n# PATCH_APPLY_FAILURE_CONTEXT (files that failed to apply; use these exact current contents)\n",
      failureSnapshot,
    );
  }

  inputParts.push("\n\n# ATTEMPT\n", String(attempt));

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

  // ─────────────────────────────────────────────────────────
  // ★ CHANGED: robust extraction with salvage fallback
  // ─────────────────────────────────────────────────────────

  let diff = null;
  let prBodyEn = null;

  // Step A: try standard extraction first
  const diffBlocks = extractAllCodeBlocks(out, "diff");
  const mdBlocks = [
    ...extractAllCodeBlocks(out, "md"),
    ...extractAllCodeBlocks(out, "markdown"),
    ...extractAllCodeBlocks(out, "mdx"),
  ];

  diff = pickBestDiff(diffBlocks);
  prBodyEn = pickBestMd(mdBlocks);

  // Step B: if standard parsing failed, try salvage
  if (!diff || !looksLikeUnifiedDiff(diff)) {
    console.log("[ai:run] standard diff extraction failed, trying salvage...");
    const salvaged = salvageDiff(out);
    if (salvaged) {
      console.log("[ai:run] salvage parser recovered a valid diff");
      diff = salvaged;
    }
  }

  if (!prBodyEn) {
    console.log("[ai:run] standard md extraction failed, trying salvage...");
    prBodyEn = salvagePrBody(out, task);
    console.log("[ai:run] salvage parser generated PR body");
  }

  // Step C: if still no diff AND provider is OpenAI, try format-repair call
  if ((!diff || !looksLikeUnifiedDiff(diff)) && provider === "openai") {
    console.log(
      "[ai:run] diff still missing after salvage, attempting OpenAI format-repair...",
    );
    const repaired = await openaiFormatRepair({
      apiKey: mustEnv("OPENAI_API_KEY"),
      model,
      badOutput: out,
      maxTokens: maxOutputTokens,
    });

    if (repaired) {
      // Append repair output to last-output for debugging
      await fs.writeFile(
        LAST_OUTPUT_PATH,
        out + "\n\n# FORMAT_REPAIR_OUTPUT\n" + repaired,
        "utf8",
      );

      // Try standard extraction on repaired output
      const repairedDiffBlocks = extractAllCodeBlocks(repaired, "diff");
      const repairedDiff = pickBestDiff(repairedDiffBlocks);
      if (repairedDiff && looksLikeUnifiedDiff(repairedDiff)) {
        console.log("[ai:run] format-repair recovered a valid diff");
        diff = repairedDiff;
      } else {
        // Try salvage on repaired too
        const salvagedRepair = salvageDiff(repaired);
        if (salvagedRepair) {
          console.log("[ai:run] salvage on repaired output recovered diff");
          diff = salvagedRepair;
        }
      }

      // Also try to get PR body from repaired output if still missing meaningful content
      if (!prBodyEn || prBodyEn.includes("auto-generated")) {
        const repairedMd = [
          ...extractAllCodeBlocks(repaired, "md"),
          ...extractAllCodeBlocks(repaired, "markdown"),
        ];
        const repairedBody = pickBestMd(repairedMd);
        if (repairedBody) prBodyEn = repairedBody;
      }
    }
  }

  // Final validation
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

  // ─────────────────────────────────────────────────────────
  // ★ CHANGED: use lenient tryGitApply instead of single check
  // ─────────────────────────────────────────────────────────

  const applyResult = tryGitApply(PATCH_PATH);

  if (!applyResult.ok) {
    const debug = `\n\n# GIT_APPLY_CHECK_FAILED\n${applyResult.stderr}\n`;
    await fs.writeFile(LAST_OUTPUT_PATH, out + debug, "utf8");
    const failed = parseFailedPathsFromGitApply(applyResult.stderr);
    const failedList = failed.length
      ? `\nFailed paths:\n- ${failed.join("\n- ")}`
      : "";
    throw new Error(
      `Generated patch is not applicable. See ${LAST_OUTPUT_PATH} and ${PATCH_PATH}${failedList}`,
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

  // Tokens/temperature knobs
  const maxOutputTokens = readNumber("AI_MAX_OUTPUT_TOKENS", 2200);
  const temperature = readOptionalNumber("ANTHROPIC_TEMPERATURE");

  let previousOut = "";
  let failureSnapshot = "";
  let success = false;

  const repoSnapshot = await buildRepoSnapshot(requiredFiles);

  // ★ CHANGED: 4 attempts total — attempt 1: OpenAI, attempt 2: OpenAI retry
  //   (only if attempt 1 was a parse/format failure, not a policy violation),
  //   attempt 3-4: Claude fix/review
  const MAX_ATTEMPTS = 4;
  let openaiFormatFailed = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Decide provider:
      //   attempt 1: always OpenAI
      //   attempt 2: OpenAI retry if format failure, otherwise Claude
      //   attempt 3+: always Claude
      let provider;
      if (attempt === 1) {
        provider = "openai";
      } else if (attempt === 2 && openaiFormatFailed) {
        provider = "openai";
        console.log(
          "[ai:run] retrying OpenAI (attempt 2) due to format failure...",
        );
      } else {
        provider = "anthropic";
      }

      const model = provider === "openai" ? openaiModel : claudeModel;

      if (provider === "openai") {
        console.log(`[ai:run] calling OpenAI (code), attempt ${attempt}...`);
        mustEnv("OPENAI_API_KEY");
      } else {
        console.log(
          `[ai:run] calling Claude (Anthropic) for fix/review, attempt ${attempt}...`,
        );
        mustEnv("ANTHROPIC_API_KEY");
      }

      const extraRules =
        attempt === 1
          ? ""
          : [
              "Your previous output was invalid or failed quality gates.",
              "Regenerate a correct unified diff with full headers and at least one @@ hunk per file.",
              "Output ONE diff block only. No duplicate file diffs.",
              "Prefer minimal hunks; do not replace whole files unless required.",
              "Reminder: no @testing-library/*, no toBeInTheDocument, no app/**/__tests__.",
              "Most important: the patch MUST apply cleanly to the provided REPO_SNAPSHOT.",
              "Context lines in hunks must EXACTLY match the file contents shown in REPO_SNAPSHOT.",
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
        repoSnapshot,
        failureSnapshot,
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

        if (attempt === MAX_ATTEMPTS)
          throw new Error(`Dry-run failed. See ${GATES_LOG_PATH}`);
        continue;
      }

      success = true;
      break;
    } catch (e) {
      const msg = e?.message || String(e || "");
      console.error(`[ai:run] attempt ${attempt} failed:`, msg);

      // Track if this was a format/parse failure (for OpenAI retry logic)
      if (
        attempt === 1 &&
        (msg.includes("No diff block found") ||
          msg.includes("No md PR body block found") ||
          msg.includes("Invalid unified diff"))
      ) {
        openaiFormatFailed = true;
      }

      try {
        const last = await fs.readFile(LAST_OUTPUT_PATH, "utf8");
        previousOut = last;
      } catch {
        // ignore
      }

      // apply-check 실패면, 실패 파일 스냅샷을 만들어 다음 시도에 붙인다
      if (msg.includes("Generated patch is not applicable")) {
        // patch.diff는 이미 만들어져 있을 수 있음. stderr는 last-output에 tail로 들어가있음.
        const last = await fs
          .readFile(LAST_OUTPUT_PATH, "utf8")
          .catch(() => "");
        const failedPaths = parseFailedPathsFromGitApply(last);
        if (failedPaths.length) {
          failureSnapshot = await buildFailureSnapshot(failedPaths);
        } else {
          // fallback: git apply --check stderr를 직접 재실행해서 파싱
          const chk = runCapture("git", [
            "apply",
            "--check",
            "--recount",
            "--whitespace=nowarn",
            "-p1",
            PATCH_PATH,
          ]);
          const paths2 = parseFailedPathsFromGitApply(chk.stderr);
          if (paths2.length)
            failureSnapshot = await buildFailureSnapshot(paths2);
        }
      }

      if (attempt === MAX_ATTEMPTS) throw e;
    }
  }

  if (!success) {
    throw new Error(
      `[ai:run] failed: could not generate a valid diff+md after ${MAX_ATTEMPTS} attempts. See ${LAST_OUTPUT_PATH}`,
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
