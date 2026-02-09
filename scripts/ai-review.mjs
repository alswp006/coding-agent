import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const GH_API = "https://api.github.com";
const OPENAI_API = "https://api.openai.com/v1/responses";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function readEnv(name, fallback = "") {
  const v = process.env[name];
  return v ? String(v) : fallback;
}

function clip(s, maxChars) {
  if (!s) return "";
  const str = String(s);
  return str.length > maxChars
    ? str.slice(0, maxChars) + "\n\n[TRUNCATED]\n"
    : str;
}

function clipBytes(s, maxBytes) {
  // UTF-8 byte-based clip (safer for API limits than char-based)
  const buf = Buffer.from(String(s || ""), "utf8");
  if (buf.length <= maxBytes) return String(s || "");
  const sliced = buf.subarray(0, maxBytes);
  return sliced.toString("utf8") + "\n\n[TRUNCATED_BY_BYTES]\n";
}

async function ghFetch(
  path,
  { token, method = "GET", headers = {}, body } = {},
) {
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
  const n = event?.pull_request?.number;
  if (typeof n === "number") return n;
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

function summarizeChecks(checks) {
  const lines = [];
  for (const c of checks) {
    const name = c.name || "(unnamed)";
    const concl = c.conclusion || c.status || "unknown";
    lines.push(`- ${name}: ${concl}`);
  }
  return lines.length ? lines.join("\n") : "(no checks found)";
}

/**
 * Robust extraction for OpenAI Responses API.
 * Handles: output_text, output[] content, and a few fallbacks.
 */
function extractTextFromResponsesApi(json) {
  if (!json) return "";

  if (typeof json.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  if (Array.isArray(json.output)) {
    let t = "";
    for (const item of json.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (!part) continue;
        if (typeof part.text === "string") t += part.text;
        if (typeof part.output_text === "string") t += part.output_text;
      }
    }
    if (t.trim()) return t.trim();
  }

  // Extremely defensive fallbacks (rare)
  if (Array.isArray(json.content)) {
    const t = json.content
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .join("");
    if (t.trim()) return t.trim();
  }

  return "";
}

async function openaiReview({
  apiKey,
  model,
  taskMd,
  prTitle,
  diffText,
  checksSummary,
}) {
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

  // IMPORTANT:
  // - Responses API input can be large; guard with byte clipping.
  // - Keep structure stable to reduce empty outputs.
  const prBlock = [
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

  // Byte-based clip for safety (GitHub diff can be huge)
  const safeInput = clipBytes(prBlock, 220_000); // ~220KB hard cap (tune if needed)

  // Responses API expects `input` - allow message array.
  // Put "instructions" as system-like text in the first item for maximum compatibility.
  const payload = {
    model,
    input: [
      { role: "system", content: instructions },
      { role: "user", content: safeInput },
    ],
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

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`OpenAI API failed: ${res.status} ${raw}`);
  }

  let j;
  try {
    j = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(
      `OpenAI API returned non-JSON response (len=${raw.length})`,
    );
  }

  const out = extractTextFromResponsesApi(j);
  if (!out) {
    // helpful debug without leaking secrets
    const dbg = {
      model,
      id: j?.id,
      has_output_text: typeof j?.output_text === "string",
      output_len: Array.isArray(j?.output) ? j.output.length : 0,
      usage: j?.usage ? { ...j.usage } : undefined,
    };
    throw new Error(
      `OpenAI returned empty output. debug=${JSON.stringify(dbg)}`,
    );
  }
  return out;
}

async function main() {
  const token = mustEnv("GITHUB_TOKEN");
  const apiKey = mustEnv("OPENAI_API_KEY");

  const model = readEnv("OPENAI_MODEL", "gpt-4.1-mini");

  // 운영 옵션:
  // - AI_REVIEW_SOFT_FAIL=1 이면 OpenAI 실패 시에도 exit 0 (CI를 죽이지 않음)
  const softFail = readEnv("AI_REVIEW_SOFT_FAIL", "") === "1";

  // quick debug (no secret)
  console.log(`[ai-review] model=${model}`);
  console.log(`[ai-review] openai_key_len=${apiKey?.length ?? 0}`);

  const eventPath = mustEnv("GITHUB_EVENT_PATH");
  const eventRaw = await fs.readFile(eventPath, "utf8");
  const event = JSON.parse(eventRaw);

  const repoFull = mustEnv("GITHUB_REPOSITORY"); // owner/repo
  const [owner, repo] = repoFull.split("/");
  const prNumber = getPrNumberFromEvent(event);
  if (!prNumber)
    throw new Error("Could not determine PR number from event payload");

  const pr = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    token,
  });
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
    const checks = await ghFetch(
      `/repos/${owner}/${repo}/commits/${ref}/check-runs`,
      { token },
    );
    const runs = Array.isArray(checks.check_runs) ? checks.check_runs : [];
    checksSummary = summarizeChecks(runs);
  }

  // 3) task
  const taskMd = await readTaskMd();

  // 4) openai review
  let body = "";
  try {
    body = await openaiReview({
      apiKey,
      model,
      taskMd,
      prTitle,
      diffText,
      checksSummary,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("[ai-review] OpenAI review failed:", msg);

    if (softFail) {
      // Leave a comment indicating skip, but do not fail CI
      const notice = [
        "## AI Review Skipped",
        "",
        "AI review step failed to produce output in this run.",
        "",
        "### Error",
        "```",
        clip(msg, 2000),
        "```",
        "",
        "_This comment was generated by ai-review._",
      ].join("\n");

      await ghPostComment({
        token,
        owner,
        repo,
        issueNumber: prNumber,
        body: notice,
      });

      console.log("[ai-review] soft-fail enabled; exiting 0");
      process.exit(0);
    }

    throw e;
  }

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
