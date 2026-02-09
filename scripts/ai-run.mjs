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
// Small utils
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

// -----------------------------
// TASK parsing (cannot edit TASK.md)
// - 1) markdown "## Files to create" section
// - 2) fallback: parse JSON fields like files/files_to_create/file_paths etc
// -----------------------------

function normalizePathString(s) {
  const t = String(s || "")
    .trim()
    .replace(/\*\*/g, "");
  return t;
}

function parseRequiredFilesFromTaskMarkdown(taskText) {
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
    if (m) required.push(normalizePathString(m[1]));
  }
  return required.filter(Boolean);
}

function extractStringArrayField(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (Array.isArray(v)) {
      const out = v
        .filter((x) => typeof x === "string")
        .map((x) => normalizePathString(x))
        .filter(Boolean);
      if (out.length) return out;
    }
  }
  return [];
}

function parseRequiredFilesFromTaskJson(taskText) {
  const t = String(taskText || "").trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return [];

  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    return [];
  }

  // Common candidates (you can extend later without changing TASK format)
  const direct = extractStringArrayField(obj, [
    "files",
    "files_to_create",
    "file_paths",
    "paths",
  ]);
  if (direct.length) return direct;

  const nestedTask = extractStringArrayField(obj?.task, [
    "files",
    "files_to_create",
    "file_paths",
    "paths",
  ]);
  if (nestedTask.length) return nestedTask;

  const nestedMeta = extractStringArrayField(obj?.meta, [
    "files",
    "files_to_create",
    "file_paths",
    "paths",
  ]);
  if (nestedMeta.length) return nestedMeta;

  return [];
}

function parseRequiredFilesFromTask(taskText) {
  const fromMd = parseRequiredFilesFromTaskMarkdown(taskText);
  if (fromMd.length) return fromMd;

  const fromJson = parseRequiredFilesFromTaskJson(taskText);
  if (fromJson.length) return fromJson;

  return [];
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
// Diff structural guards
// -----------------------------

function listTouchedFilesFromDiff(diff) {
  const files = [];
  const re = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let m;
  while ((m = re.exec(diff)) !== null) {
    files.push(m[2]);
  }
  return files;
}

function assertNoDuplicateFileDiffs(diff) {
  const touched = listTouchedFilesFromDiff(diff);
  const seen = new Set();
  const dup = new Set();
  for (const f of touched) {
    if (seen.has(f)) dup.add(f);
    seen.add(f);
  }
  if (dup.size) {
    throw new Error(
      `Patch contains duplicate diff blocks for the same file(s):\n- ${Array.from(
        dup,
      ).join("\n- ")}\nRegenerate diff with exactly ONE diff block per file.`,
    );
  }
}

function assertOnlyTouchesAllowedPaths(diff, allowedPaths) {
  const touched = Array.from(new Set(listTouchedFilesFromDiff(diff)));
  const notAllowed = touched.filter((p) => !allowedPaths.includes(p));
  if (notAllowed.length) {
    throw new Error(
      `Patch touches files not allowed by TASK allowlist:\n- ${notAllowed.join("\n- ")}\n` +
        `Regenerate diff touching ONLY allowed paths.`,
    );
  }
}

function assertOnlyNewFilesDiff(diff) {
  // When TASK doesn't specify files, enforce: new files only (no modify/delete/rename)
  // Heuristic checks:
  // - every file block should contain "new file mode"
  // - should contain "--- /dev/null" and "+++ b/<path>"
  // - should NOT contain "deleted file mode"
  // - should NOT contain "rename from"/"rename to"
  if (/^deleted file mode/m.test(diff)) {
    throw new Error(
      `Policy: TASK did not specify target files, so delete operations are forbidden. Regenerate diff with ONLY new files.`,
    );
  }
  if (/^rename from /m.test(diff) || /^rename to /m.test(diff)) {
    throw new Error(
      `Policy: TASK did not specify target files, so rename operations are forbidden. Regenerate diff with ONLY new files.`,
    );
  }

  const fileHeaders = diff.match(/^diff --git a\/.+ b\/.+$/gm) || [];
  for (const header of fileHeaders) {
    // For each file block, require "new file mode" somewhere after header before next diff
    const esc = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reBlock = new RegExp(`${esc}[\\s\\S]*?(?=^diff --git |\\s*$)`, "m");
    const block = diff.match(reBlock)?.[0] || "";
    if (!/^new file mode /m.test(block)) {
      throw new Error(
        `Policy: TASK did not specify target files, so modifying existing files is forbidden.\n` +
          `Offending block:\n${header}\n` +
          `Regenerate diff with ONLY new files (use new file mode + /dev/null).`,
      );
    }
    if (!/^--- \/dev\/null$/m.test(block) || !/^\+\+\+ b\//m.test(block)) {
      throw new Error(
        `Policy: new files must use /dev/null headers.\n` +
          `Offending block:\n${header}\n` +
          `Regenerate diff with proper new file format.`,
      );
    }
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

  if (forbidAppDraftsTests) {
    const re =
      /^diff --git a\/app\/drafts\/.*__tests__\/.* b\/app\/drafts\/.*__tests__\/.*/m;
    if (re.test(diff)) {
      throw new Error(
        `Policy violation: tests under app/drafts/**/__tests__ are not allowed (breaks typecheck/lint due to missing deps).`,
      );
    }
  }

  if (forbidReactTestingLib) {
    const re = /@testing-library\/react/;
    if (re.test(diff)) {
      throw new Error(
        `Policy violation: patch introduces @testing-library/react but repo doesn't include it.`,
      );
    }
  }

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
  const body = {
    model,
    input: [
      ...(system && String(system).trim()
        ? [{ role: "system", content: String(system) }]
        : []),
      { role: "user", content: String(userText || "") },
    ],
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
      temperature: undefined,
    })
  ).trimEnd();

  return out ? out : text;
}

// -----------------------------
// Agent call
// -----------------------------
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
    : [
        "IMPORTANT POLICY (because TASK does not provide an explicit file list):",
        "- Your diff MUST create ONLY NEW FILES (no edits/deletes/renames of existing files).",
        "- Every file must be `new file mode` and use `--- /dev/null` headers.",
      ].join("\n");

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
    "- Do NOT include duplicate diff blocks for the same file.",
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

  // -----------------------------
  // Structural sanity
  // -----------------------------
  assertNoDuplicateFileDiffs(diff);

  // required files (if task provides)
  mustIncludeRequiredFiles(diff, requiredFiles);

  // If task does NOT provide explicit target files:
  // enforce "new files only" to prevent apply failures due to context mismatches.
  if (!requiredFiles.length) {
    assertOnlyNewFilesDiff(diff);
  } else {
    // if we do have an explicit allowlist, enforce only those paths
    assertOnlyTouchesAllowedPaths(diff, requiredFiles);
  }

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

  // -----------------------------
  // check patch applicability:
  // 1) normal --check
  // 2) fallback --check --3way
  // -----------------------------
  const chk = runCapture("git", [
    "apply",
    "--check",
    "--recount",
    "--whitespace=nowarn",
    "-p1",
    PATCH_PATH,
  ]);

  const chk3 =
    chk.status === 0
      ? chk
      : runCapture("git", [
          "apply",
          "--check",
          "--3way",
          "--recount",
          "--whitespace=nowarn",
          "-p1",
          PATCH_PATH,
        ]);

  if (chk3.status !== 0) {
    const debug = `\n\n# GIT_APPLY_CHECK_FAILED\n${chk3.stderr}\n`;
    await fs.writeFile(LAST_OUTPUT_PATH, out + debug, "utf8");
    throw new Error(
      `Generated patch is not applicable. See ${LAST_OUTPUT_PATH} and ${PATCH_PATH}`,
    );
  }
}

// -----------------------------
// Gates log helpers
// -----------------------------
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

// -----------------------------
// Main
// -----------------------------
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

  // Shared knobs
  const maxOutputTokens = readNumber("AI_MAX_OUTPUT_TOKENS", 2200);
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
              "Your previous output was invalid or failed patch applicability / quality gates.",
              "Regenerate a correct unified diff with full headers and at least one @@ hunk per file.",
              "Do not output header-only diffs (e.g., index ...e69de29).",
              "Do not duplicate diff blocks for the same file.",
              "If TASK has no file list, create ONLY NEW FILES; do not modify existing files.",
              "Reminder: no @testing-library/*, no toBeInTheDocument, no app/**/__tests__.",
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
