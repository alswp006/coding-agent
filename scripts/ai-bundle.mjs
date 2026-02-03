import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();

function read(p) {
  const full = path.join(ROOT, p);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

function exists(p) {
  return fs.existsSync(path.join(ROOT, p));
}

function readFirstMatch(candidates) {
  for (const p of candidates) {
    if (exists(p)) return { path: p, content: read(p) };
  }
  return { path: candidates[0], content: "" };
}

function safeCmd(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) return "";
  return (r.stdout || "").trimEnd();
}

function fence(lang, content) {
  const body = (content ?? "").trimEnd();
  return "```" + lang + "\n" + body + "\n```\n\n";
}

// 1) agent prompt files (existing)
const agentFiles = [
  ".ai/prompts/core/system.md",
  ".ai/prompts/core/planner.md",
  ".ai/prompts/core/implementer.md",
  ".ai/prompts/core/reviewer.md",
  ".ai/prompts/core/qa.md",
  ".ai/prompts/core/release.md",
  ".ai/project/overlay.md",
  ".ai/roles/00-overview.md",
  ".ai/config/commands.json",
  ".ai/config/budget.json",
  ".ai/TASK.md",
];

// 2) repo context files (NEW) — 핵심: “이미 있는 설정을 모델이 알게”
const repoContextCandidates = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "next.config.js",
  "next.config.mjs",
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc",
  ".eslintrc.json",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierignore",
];

const vitestConfig = readFirstMatch([
  "vitest.config.mts",
  "vitest.config.ts",
  "vitest.config.mjs",
  "vitest.config.js",
]);

// 3) file tree snapshot (NEW) — “어떤 파일이 이미 존재하는지”
// 너무 길어지지 않게 상위 일부만.
const fileTree =
  safeCmd("git", ["ls-files"]) ||
  safeCmd("bash", ["-lc", "find . -maxdepth 4 -type f | sed 's#^./##'"]);

const fileTreeLimited = fileTree
  .split("\n")
  .filter(Boolean)
  .filter((p) => !p.startsWith("node_modules/"))
  .filter((p) => !p.startsWith(".git/"))
  .slice(0, 400)
  .join("\n");

let out = `# AI Prompt Bundle (Single PR)\n\n`;

out += `## Output requirements\n`;
out += `- Return ONE unified diff inside a single \`\`\`diff code fence.\n`;
out += `- Also include PR body: Summary / How to test / Risk & rollback / Notes.\n`;
out += `- IMPORTANT: Respect existing repo config. Do NOT create duplicate config files.\n`;
out += `- If vitest.config.mts exists, never create vitest.config.ts.\n\n`;

// --- repo context first (so the model “sees reality” before the prompts)
out += `---\n## REPO CONTEXT: file tree (top 400)\n\n`;
out += fence("txt", fileTreeLimited || "(file tree unavailable)");

out += `---\n## REPO CONTEXT: vitest config\n\n`;
out += `### detected: ${vitestConfig.path}\n\n`;
out += fence("ts", vitestConfig.content || "(not found)");

for (const f of repoContextCandidates) {
  if (!exists(f)) continue;
  out += `---\n## REPO CONTEXT FILE: ${f}\n\n`;
  const lang = f.endsWith(".json")
    ? "json"
    : f.endsWith(".yaml") || f.endsWith(".yml")
      ? "yaml"
      : f.endsWith(".js") || f.endsWith(".mjs")
        ? "js"
        : "txt";
  out += fence(lang, read(f));
}

// --- then agent prompt files
for (const f of agentFiles) {
  out += `---\n## FILE: ${f}\n\n`;
  out += fence("md", read(f));
}

fs.writeFileSync(path.join(ROOT, ".ai/PROMPT_BUNDLE.md"), out);
console.log("Generated: .ai/PROMPT_BUNDLE.md");
