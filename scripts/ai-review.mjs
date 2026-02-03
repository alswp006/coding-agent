import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const GH_API = "https://api.github.com";
const OPENAI_API = "https://api.openai.com/v1/responses";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function clip(s, maxChars) {
  if (!s) return "";
  return s.length > maxChars ? s.slice(0, maxChars) + "\n\n[TRUNCATED]\n" : s;
}

async function ghFetch(path, { token, method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "ai-review-bot",
      Accept: "application/vnd.github+json",
      ...headers,
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${t}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  return await res.text();
}

async function ghPostComment({ token, owner, repo, issueNumber, body }) {
  await ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    token,
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

function getPrNumberFromEvent(event) {
  // pull_request event payload
  const n = event?.pull_request?.number;
  if (typeof n === "number") return n;
  // issue_comment etc fallback
  const n2 = event?.number;
  if (typeof n2 === "number") return n2;
  return null;
}

async function readTaskMd() {
  const p = ".ai/TASK.md";
  if (!existsSync(p)) return "(no .ai/TASK.md found in repo)";
  const t = await fs.readFile(p, "utf8");
  return t.trim() ? t : "(empty .ai/TASK.md)";
}

async function openaiReview({ apiKey, model, taskMd, prTitle, diffText, checksSummary }) {
  const instructions = [
    "You are a senior engineer reviewing a GitHub pull request.",
    "You must review for: spec compliance (TASK.md), correctness, edge cases, maintainability, test adequacy, and risk.",
    "Be concrete: reference files/lines/patch hunks when possible.",
    "Output in GitHub-flavored Markdown with these sections EXACTLY:",
    "1) Summary",
    "2) Spec compliance (map to Acceptance Criteria / DoD; say PASS/FAIL per item)",
    "3) Risky spots (potential bugs/regressions, including why)",
    "4) Test plan (what to add/what to run)",
    "5) Score (0-100) and rationale",
    "At the end include a single line: `FINAL_SCORE: <number>`",
    "Do not include any other JSON or additional sections.",
  ].join("\n");

  const input = [
    `PR Title: ${prTitle}`,
    "",
    "=== TASK.md ===",
    clip(taskMd, 18_000),
    "",
    "=== CI Checks Summary ===",
    clip(checksSummary, 6_000),
    "",
    "=== PR Diff (unified) ===",
    clip(diffText, 90_000),
  ].join("\n");

  const payload = {
    model,
    instructions,
    input,
    max_output_tokens: 1800,
    store: false,
  };

  const res = await fetch(OPENAI_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI API failed: ${res.status} ${t}`);
  }

  const j = await res.json();
  const out = (j.output_text ?? "").trim();
  if (!out) throw new Error("OpenAI returned empty output");
  return out;
}

function summarizeChecks(checks) {
  // checks: list of check-runs (name, conclusion, status, details_url)
  const lines = [];
  for (const c of checks) {
    const name = c.name || "(unnamed)";
    const concl = c.conclusion || c.status || "unknown";
    lines.push(`- ${name}: ${concl}`);
  }
  return lines.length ? lines.join("\n") : "(no checks found)";
}

async function main() {
  const token = mustEnv("GITHUB_TOKEN");
  const apiKey = mustEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const eventPath = mustEnv("GITHUB_EVENT_PATH");
  const eventRaw = await fs.readFile(eventPath, "utf8");
  const event = JSON.parse(eventRaw);

  const repoFull = mustEnv("GITHUB_REPOSITORY"); // owner/repo
  const [owner, repo] = repoFull.split("/");
  const prNumber = getPrNumberFromEvent(event);
  if (!prNumber) throw new Error("Could not determine PR number from event payload");

  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, { token });
  const prTitle = pr.title || `(PR #${prNumber})`;

  // 1) diff
  const diffText = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    token,
    headers: { Accept: "application/vnd.github.v3.diff" },
  });

  // 2) checks
  const ref = pr.head?.sha;
  let checksSummary = "(no check-runs)";
  if (ref) {
    const checks = await ghFetch(`/repos/${owner}/${repo}/commits/${ref}/check-runs`, { token });
    const runs = Array.isArray(checks.check_runs) ? checks.check_runs : [];
    checksSummary = summarizeChecks(runs);
  }

  // 3) task
  const taskMd = await readTaskMd();

  // 4) openai review
  const body = await openaiReview({
    apiKey,
    model,
    taskMd,
    prTitle,
    diffText,
    checksSummary,
  });

  const marker = "\n\n---\n\n_This comment was generated by ai-review._";
  await ghPostComment({
    token,
    owner,
    repo,
    issueNumber: prNumber,
    body: body + marker,
  });

  console.log(`[ai-review] commented on PR #${prNumber}`);
}

main().catch((e) => {
  console.error("[ai-review] failed:", e?.message || e);
  process.exit(1);
});
