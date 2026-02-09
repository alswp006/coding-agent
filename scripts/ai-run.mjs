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

function extractAllCodeBlocksAnyLang(text, langs) {
  const blocks = [];
  for (const l of langs) {
    blocks.push(...extractAllCodeBlocks(text, l));
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

function normalizeNewlines(s) {
  return String(s || "").replace(/\r\n/g, "\n");
}

/**
 * Fallback diff extraction:
 * - If model didn't use ```diff fences, try to locate the first "diff --git" block.
 * - Stop at the start of the PR body fence if present.
 */
function extractUnifiedDiffFromLooseText(text) {
  const t = normalizeNewlines(text);

  // If there is a fenced diff-like block but with wrong tag, strip fences first
  const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g;
  const candidates = [];
  let m;
  while ((m = fenceRe.exec(t)) !== null) {
    const body = (m[1] || "").trimEnd();
    if (/^diff --git /m.test(body)) candidates.push(body);
  }
  if (candidates.length) {
    const best = pickBestDiff(candidates);
    return best && looksLikeUnifiedDiff(best) ? best : best;
  }

  const idx = t.search(/^diff --git /m);
  if (idx === -1) return null;

  // cut from idx to end
  let diff = t.slice(idx).trimEnd();

  // If an md fence exists after, cut before it
  const mdFenceIdx = diff.search(/^```(md|markdown|mdx)\b/m);
  if (mdFenceIdx !== -1) diff = diff.slice(0, mdFenceIdx).trimEnd();

  // If another random prose section like "```md" isn't present but "```" appears, don't cut blindly.
  return diff;
}

/**
 * Fallback PR body extraction:
 * - If no md fenced block, attempt to use remaining text after diff block.
 * - Or synthesize a minimal PR body to satisfy ai-pr.
 */
function extractPrBodyFromLooseText(text) {
  const t = normalizeNewlines(text);

  // 1) If there is any fenced md/markdown/mdx block, prefer it (caller already tries that)
  // 2) Try to find content after the last triple backtick that contains diff
  const lastDiffIdx = t.lastIndexOf("diff --git ");
  if (lastDiffIdx !== -1) {
    // find end of diff-ish region: if there is a closing fence after it, take after fence
    const after = t.slice(lastDiffIdx);
    const closeFence = after.indexOf("```");
    if (closeFence !== -1) {
      // skip first fence maybe; just take everything after the next closing fence
      const afterClose = after.slice(closeFence + 3);
      const maybe = afterClose.trim();
      if (maybe.length >= 120) return maybe;
    }
  }

  // 3) Use whole text if it's reasonably long and not a diff
  if (!/^diff --git /m.test(t) && t.trim().length >= 200) return t.trim();

  // 4) Synthesize minimal body (always valid)
  return [
    "## Summary",
    "- Apply AI-generated patch for the current TASK.",
    "",
    "## How to test",
    "```bash",
    "pnpm test",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm format:check",
    "```",
    "",
    "## Risk & rollback",
    "- Low risk (scaffold-level). Roll back by reverting this PR.",
    "",
    "## Notes",
    "- No API call should be triggered by the UI action in this packet.",
  ].join("\n");
}

/**
 * Parse TASK.md for required files.
 * Supports BOTH:
 * 1) Markdown section:
 *    ## Files to create
 *    - path
 * 2) JSON task:
 *    { "files": ["path1", ...] } OR { "task": { "files": [...] } }
 */
function parseRequiredFilesFromTask(taskText) {
  // 1) Markdown section "## Files to create"
  {
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

    if (required.length) return required.map((p) => p.replace(/\*\*/g, ""));
  }

  // 2) JSON 형태 지원
  try {
    const j = JSON.parse(taskText);
    const files = Array.isArray(j?.files)
      ? j.files
      : Array.isArray(j?.task?.files)
        ? j.task.files
        : [];
    if (files.length) {
      return files
        .filter((x) => typeof x === "string" && x.trim())
        .map((p) => String(p).trim().replace(/\*\*/g, ""));
    }
  } catch {
    // ignore
  }

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
// Patch helpers (for apply-fail recovery)
// -----------------------------

function parseTouchedPathsFromDiff(diff) {
  const out = [];
  const re = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let m;
  while ((m = re.exec(diff)) !== null) {
    out.push({ aPath: m[1], bPath: m[2] });
  }
  return out;
}

async function buildCurrentFileContextFromDiff(diff) {
  const touched = parseTouchedPathsFromDiff(diff);
  const unique = new Map();

  for (const t of touched) {
    const p =
      t.bPath && t.bPath !== "/dev/null"
        ? t.bPath
        : t.aPath && t.aPath !== "/dev/null"
          ? t.aPath
          : null;
    if (!p) continue;
    if (unique.has(p)) continue;
    unique.set(p, true);
  }

  const paths = [...unique.keys()];
  if (!paths.length) return "";

  const chunks = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      chunks.push(`## ${p}\n(does not exist in worktree)\n`);
      continue;
    }
    const content = await fs.readFile(p, "utf8").catch(() => "");
    const clipped =
      content.length > 30_000
        ? content.slice(0, 30_000) + "\n\n/* [TRUNCATED] */\n"
        : content;

    const lang =
      p.endsWith(".ts") || p.endsWith(".mts")
        ? "ts"
        : p.endsWith(".tsx")
          ? "tsx"
          : p.endsWith(".js") || p.endsWith(".mjs")
            ? "js"
            : p.endsWith(".md")
              ? "md"
              : "";

    chunks.push(
      [`## ${p}`, "```" + lang, clipped.trimEnd(), "```", ""].join("\n"),
    );
  }

  return ["# CURRENT_WORKTREE_FILE_SNAPSHOTS", "", ...chunks].join("\n");
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

function assertNoRootPageEditsWhenDraftRoute(taskText, diff) {
  const mentionsDraftRoute =
    /\/drafts\/new/i.test(taskText) || /\bdrafts\/new\b/i.test(taskText);

  if (!mentionsDraftRoute) return;

  const rootPageRe = /^diff --git a\/app\/page\.tsx b\/app\/page\.tsx$/m;
  if (rootPageRe.test(diff)) {
    throw new Error(
      `Policy violation: TASK references /drafts/new, so do NOT modify app/page.tsx. Implement page under app/drafts/new/page.tsx instead.`,
    );
  }
}

// -----------------------------
// Anthropic API
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
// OpenAI API (Responses)
// -----------------------------
function extractOpenAIText(json) {
  const out = [];

  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    out.push(json.output_text);
  }

  const output = Array.isArray(json?.output) ? json.output : [];
  for (const o of output) {
    const content = Array.isArray(o?.content) ? o.content : [];
    for (const c of content) {
      if (c && c.type === "output_text" && typeof c.text === "string")
        out.push(c.text);
      if (c && c.type === "text" && typeof c.text === "string")
        out.push(c.text);
    }
    if (o && o.type === "output_text" && typeof o.text === "string")
      out.push(o.text);
  }

  return out.join("").trim();
}

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
    input: String(userText || ""),
  };

  if (system && String(system).trim()) body.instructions = String(system);
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

  return String(extractOpenAIText(json) || "");
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
      temperature: 0,
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
  extraContext,
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

  if (extraContext) {
    inputParts.push("\n\n", extraContext);
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
      temperature: typeof temperature === "number" ? temperature : 0, // OpenAI는 0이 안정적
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

  // ---- DIFF extraction: accept diff/patch/git/udiff + fallback to loose text
  const diffBlocks = extractAllCodeBlocksAnyLang(out, [
    "diff",
    "patch",
    "git",
    "gitdiff",
    "udiff",
    "unified-diff",
  ]);
  const mdBlocks = extractAllCodeBlocksAnyLang(out, ["md", "markdown", "mdx"]);

  let diff = pickBestDiff(diffBlocks);
  let prBodyEn = pickBestMd(mdBlocks);

  if (!diff) diff = extractUnifiedDiffFromLooseText(out);
  if (!prBodyEn) prBodyEn = extractPrBodyFromLooseText(out);

  if (!diff) throw new Error(`No diff block found. See ${LAST_OUTPUT_PATH}`);
  if (!prBodyEn)
    throw new Error(`No md PR body found. See ${LAST_OUTPUT_PATH}`);
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
  assertNoRootPageEditsWhenDraftRoute(task, diff);

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
  const defaultBranch = `feat/ai-run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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

  const openaiModel = readString("OPENAI_MODEL", "gpt-5.2");
  const claudeModel = readString("ANTHROPIC_MODEL", "claude-sonnet-4-5");

  const maxOutputTokens = readNumber("AI_MAX_OUTPUT_TOKENS", 2200);
  const temperature = readOptionalNumber("AI_TEMPERATURE");

  let previousOut = "";
  let previousPatch = "";
  let previousFileContext = "";
  let success = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
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
              "If git apply failed, your diff did not match the repo files. Use the provided CURRENT_WORKTREE_FILE_SNAPSHOTS to craft hunks that apply cleanly.",
              "Do not output header-only diffs (e.g., index ...e69de29).",
              "Fix issues reported in the gates log if provided.",
              "Reminder: no @testing-library/*, no toBeInTheDocument, no app/**/__tests__.",
            ].join(" ");

      await cleanupArtifacts();

      const extraContext =
        attempt === 1
          ? ""
          : [
              previousPatch
                ? "# PREVIOUS_PATCH_DIFF\n```diff\n" +
                  previousPatch.trimEnd() +
                  "\n```\n"
                : "",
              previousFileContext || "",
            ]
              .filter(Boolean)
              .join("\n\n");

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
        extraContext,
      });

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

        if (existsSync(PATCH_PATH)) {
          previousPatch = await fs.readFile(PATCH_PATH, "utf8").catch(() => "");
          previousFileContext = previousPatch
            ? await buildCurrentFileContextFromDiff(previousPatch)
            : "";
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

      if (existsSync(PATCH_PATH)) {
        previousPatch = await fs.readFile(PATCH_PATH, "utf8").catch(() => "");
        previousFileContext = previousPatch
          ? await buildCurrentFileContextFromDiff(previousPatch)
          : "";
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
