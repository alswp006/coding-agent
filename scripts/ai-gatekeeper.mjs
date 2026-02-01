import fs from "node:fs";

const MARKER = "## 🤖 PR Gatekeeper Report";

// ---------- utils ----------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return String(v);
}

function csv(s) {
  return (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function containsAny(haystack, keywords) {
  const h = (haystack || "").toLowerCase();
  return keywords.some((k) => h.includes(k.toLowerCase()));
}

function truncateLines(text, maxLines) {
  const lines = (text || "").split("\n");
  if (lines.length <= maxLines) return text || "";
  return lines.slice(0, maxLines).join("\n") + "\n\n... (truncated)";
}

function secretHeuristicHit(text) {
  const t = text || "";
  const patterns = [
    /-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bAIzaSy[0-9A-Za-z\-_]{35}\b/,
    /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  ];
  return patterns.some((re) => re.test(t));
}

// ---------- GitHub API ----------
function ghFetch(token, path, { method = "GET", body } = {}) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function paginate(token, path) {
  const out = [];
  let page = 1;

  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}per_page=100&page=${page}`;
    const res = await ghFetch(token, url);
    if (!res.ok)
      throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;

    page += 1;
    if (page > 50) break; // safety
  }

  return out;
}

// ---------- policy + scoring ----------
function evaluatePolicy({
  fileNames,
  linesChanged,
  filesChanged,
  keywords,
  maxFiles,
  maxDiffLines,
  combinedPatch,
}) {
  const highRisk =
    containsAny(fileNames.join("\n"), keywords) ||
    containsAny(combinedPatch, keywords);

  const tooLarge = filesChanged > maxFiles || linesChanged > maxDiffLines;
  const secretSuspected = secretHeuristicHit(combinedPatch);

  const reasons = [];
  if (highRisk) reasons.push("High-risk keyword/path detected");
  if (tooLarge) reasons.push("Diff too large (files/lines)");
  if (secretSuspected)
    reasons.push("Secret-like pattern detected (AI review should be skipped)");

  return { highRisk, tooLarge, secretSuspected, reasons };
}

function computeScores({ linesChanged, filesChanged, policy }) {
  let risk = 0;

  // LOC
  if (linesChanged <= 50) risk += 0;
  else if (linesChanged <= 200) risk += 5;
  else if (linesChanged <= 500) risk += 12;
  else risk += 20;

  // file count
  if (filesChanged <= 2) risk += 0;
  else if (filesChanged <= 6) risk += 4;
  else risk += 10;

  // policy weights (보수적으로)
  if (policy.highRisk) risk += 25;
  if (policy.tooLarge) risk += 15;
  if (policy.secretSuspected) risk += 30;

  risk = Math.max(0, Math.min(100, risk));
  const safety = 100 - risk;
  return { risk, safety };
}

function labelsFor(scores, policy) {
  const labels = ["gatekeeper-reviewed", "ai-reviewed"];

  if (scores.safety >= 96) labels.push("ai-safe-96plus");
  else if (scores.safety >= 90) labels.push("ai-safe-90plus");
  else labels.push("ai-safe-below-90");

  if (policy.highRisk || policy.tooLarge || policy.secretSuspected)
    labels.push("ai-review-required");
  else labels.push("ai-review-optional");

  if (policy.secretSuspected) labels.push("ai-review-skipped-secrets");
  if (policy.tooLarge) labels.push("ai-review-summary-only");

  return labels;
}

function buildComment({ prNumber, scores, policy, stats, baseSha, headSha }) {
  const decision =
    policy.highRisk ||
    policy.tooLarge ||
    policy.secretSuspected ||
    scores.safety < 90
      ? "NEEDS_REVIEW"
      : "SAFE";

  const reasons = policy.reasons.length
    ? policy.reasons.map((r) => `- ${r}`).join("\n")
    : "- none";

  return `${MARKER}

### Summary
- PR: #${prNumber}
- CI: UNKNOWN (Phase1: not wired yet)
- Safety Score: **${scores.safety}/100** (Risk ${scores.risk}/100)
- Decision: **${decision}**
- High-Risk 영역: ${policy.highRisk ? "YES" : "NO"}
- Diff too large: ${policy.tooLarge ? "YES" : "NO"}
- Secret suspected: ${policy.secretSuspected ? "YES" : "NO"}

### Policy Reasons
${reasons}

### Diff Stats
- base: \`${baseSha.slice(0, 7)}\`
- head: \`${headSha.slice(0, 7)}\`
- files changed: ${stats.filesChanged}
- lines changed: ${stats.linesChanged} (add ${stats.additions}, del ${stats.deletions})

### Suggested Next Checks (MVP)
- [ ] CI 결과 확인 (다음 단계에서 자동 수집 예정)
- [ ] High-Risk면 리뷰어 1명 이상 필수
- [ ] Secret suspected면 diff에서 민감정보 유출 여부 확인 및 키 로테이션 고려
`;
}

// ---------- main ----------
async function main() {
  const token = mustEnv("GITHUB_TOKEN");
  const repoFull = mustEnv("GITHUB_REPOSITORY"); // owner/repo
  const [owner, repo] = repoFull.split("/");

  const eventPath = mustEnv("GITHUB_EVENT_PATH");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pr = event.pull_request;
  if (!pr) throw new Error("Not a pull_request event payload");

  const prNumber = pr.number;
  const baseSha = pr.base.sha;
  const headSha = pr.head.sha;

  const maxDiffLines = parseInt(process.env.GK_MAX_DIFF_LINES || "1200", 10);
  const maxFiles = parseInt(process.env.GK_MAX_FILES || "80", 10);
  const highRiskKeywords = csv(process.env.GK_HIGH_RISK_KEYWORDS || "");

  // PR files
  const files = await paginate(
    token,
    `/repos/${owner}/${repo}/pulls/${prNumber}/files?`,
  );
  const filesChanged = files.length;

  let additions = 0;
  let deletions = 0;
  const fileNames = [];
  let combinedPatch = "";

  for (const f of files.slice(0, maxFiles)) {
    additions += f.additions || 0;
    deletions += f.deletions || 0;
    fileNames.push(f.filename);

    if (typeof f.patch === "string" && f.patch.length > 0) {
      combinedPatch += `\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}\n`;
    }
  }

  const linesChanged = additions + deletions;
  combinedPatch = truncateLines(combinedPatch, maxDiffLines);

  const policy = evaluatePolicy({
    fileNames,
    linesChanged,
    filesChanged,
    keywords: highRiskKeywords,
    maxFiles,
    maxDiffLines,
    combinedPatch,
  });

  const scores = computeScores({ linesChanged, filesChanged, policy });
  const labels = labelsFor(scores, policy);

  const commentBody = buildComment({
    prNumber,
    scores,
    policy,
    stats: { filesChanged, linesChanged, additions, deletions },
    baseSha,
    headSha,
  });

  await upsertComment(token, owner, repo, prNumber, commentBody);
  await upsertLabels(token, owner, repo, prNumber, labels);

  console.log("Gatekeeper OK:", { prNumber, scores, policy, labels });
}

async function upsertComment(token, owner, repo, prNumber, body) {
  const comments = await paginate(
    token,
    `/repos/${owner}/${repo}/issues/${prNumber}/comments?`,
  );
  const existing = comments.find(
    (c) => typeof c.body === "string" && c.body.includes(MARKER),
  );

  if (existing) {
    const res = await ghFetch(
      token,
      `/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        body: { body },
      },
    );
    if (!res.ok)
      throw new Error(
        `updateComment failed: ${res.status} ${await res.text()}`,
      );
  } else {
    const res = await ghFetch(
      token,
      `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
      {
        method: "POST",
        body: { body },
      },
    );
    if (!res.ok)
      throw new Error(
        `createComment failed: ${res.status} ${await res.text()}`,
      );
  }
}

async function upsertLabels(token, owner, repo, prNumber, labels) {
  const current = await paginate(
    token,
    `/repos/${owner}/${repo}/issues/${prNumber}/labels?`,
  );
  const managedPrefixes = ["ai-", "gatekeeper-"];

  const toRemove = current
    .map((l) => l.name)
    .filter((name) => managedPrefixes.some((p) => name.startsWith(p)));

  for (const name of toRemove) {
    const encoded = encodeURIComponent(name);
    const res = await ghFetch(
      token,
      `/repos/${owner}/${repo}/issues/${prNumber}/labels/${encoded}`,
      {
        method: "DELETE",
      },
    );
    // 404는 무시(동시성)
    if (!res.ok && res.status !== 404) {
      throw new Error(
        `removeLabel failed(${name}): ${res.status} ${await res.text()}`,
      );
    }
  }

  const res = await ghFetch(
    token,
    `/repos/${owner}/${repo}/issues/${prNumber}/labels`,
    {
      method: "POST",
      body: { labels },
    },
  );
  if (!res.ok)
    throw new Error(`addLabels failed: ${res.status} ${await res.text()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
