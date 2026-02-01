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

function normalizeConclusion(c) {
  // GitHub check-run conclusion values: success, failure, neutral, cancelled, timed_out, action_required, stale, skipped
  if (!c) return "unknown";
  return String(c).toLowerCase();
}

function normalizeStatus(s) {
  // queued, in_progress, completed
  if (!s) return "unknown";
  return String(s).toLowerCase();
}

// ---------- GitHub API ----------
async function ghFetch(token, path, { method = "GET", body, accept } = {}) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function paginate(token, path, accept) {
  const out = [];
  let page = 1;

  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}per_page=100&page=${page}`;
    const res = await ghFetch(token, url, { accept });
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

// ---------- CI Summary (WP3) ----------
function extractRunId(detailsUrl) {
  // e.g. https://github.com/{owner}/{repo}/actions/runs/123456789
  const m = String(detailsUrl || "").match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

function pickFirstFailingStep(jobsPayload) {
  // jobsPayload: { jobs: [...] }
  const jobs = jobsPayload?.jobs || [];
  for (const job of jobs) {
    const steps = job.steps || [];
    for (const step of steps) {
      const concl = normalizeConclusion(step.conclusion);
      if (
        concl === "failure" ||
        concl === "cancelled" ||
        concl === "timed_out" ||
        concl === "action_required"
      ) {
        return {
          jobName: job.name || "job",
          stepName: step.name || "step",
          conclusion: concl,
        };
      }
    }
  }
  return null;
}

async function getCiSummary(token, owner, repo, refSha) {
  // Check Runs API는 "application/vnd.github+json"으로 가능 (일부 환경은 antiope-preview가 필요했지만 현재는 대부분 OK)
  const res = await ghFetch(
    token,
    `/repos/${owner}/${repo}/commits/${refSha}/check-runs`,
    {
      accept: "application/vnd.github+json",
    },
  );
  if (!res.ok) {
    return {
      overall: "UNKNOWN",
      checks: [],
      failureHints: [],
      note: `check-runs fetch failed: ${res.status}`,
    };
  }

  const data = await res.json();
  const checkRuns = Array.isArray(data.check_runs) ? data.check_runs : [];

  const checks = checkRuns.map((cr) => {
    const status = normalizeStatus(cr.status);
    const conclusion = normalizeConclusion(cr.conclusion);
    const detailsUrl = cr.details_url || "";
    const runId = extractRunId(detailsUrl);
    return {
      name: cr.name || "check",
      status,
      conclusion,
      detailsUrl,
      runId,
      appSlug: cr.app?.slug || "",
    };
  });

  // overall 판단
  let overall = "PASS";
  if (checks.length === 0) overall = "UNKNOWN";

  const hasRunning = checks.some((c) => c.status !== "completed");
  if (hasRunning) overall = "RUNNING";

  const hasFail = checks.some((c) =>
    ["failure", "cancelled", "timed_out", "action_required"].includes(
      c.conclusion,
    ),
  );
  if (hasFail) overall = "FAIL";

  // 실패 힌트: Actions Jobs/Steps까지 파고들어서 1줄 요약 만들기
  const failureHints = [];
  const runIds = [...new Set(checks.map((c) => c.runId).filter(Boolean))];

  for (const runId of runIds.slice(0, 5)) {
    const jobsRes = await ghFetch(
      token,
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
      {
        accept: "application/vnd.github+json",
      },
    );
    if (!jobsRes.ok) continue;
    const jobsPayload = await jobsRes.json();
    const firstFail = pickFirstFailingStep(jobsPayload);
    if (firstFail) {
      failureHints.push({
        runId,
        job: firstFail.jobName,
        step: firstFail.stepName,
        conclusion: firstFail.conclusion,
      });
    }
  }

  return { overall, checks, failureHints, note: null };
}

// ---------- policy + scoring (Safety) ----------
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

function computeSafetyScores({ linesChanged, filesChanged, policy }) {
  let risk = 0;

  if (linesChanged <= 50) risk += 0;
  else if (linesChanged <= 200) risk += 5;
  else if (linesChanged <= 500) risk += 12;
  else risk += 20;

  if (filesChanged <= 2) risk += 0;
  else if (filesChanged <= 6) risk += 4;
  else risk += 10;

  if (policy.highRisk) risk += 25;
  if (policy.tooLarge) risk += 15;
  if (policy.secretSuspected) risk += 30;

  risk = Math.max(0, Math.min(100, risk));
  const safety = 100 - risk;
  return { risk, safety };
}

// ---------- Code Quality Score (new) ----------
function computeQualityScore({ ci, stats, policy }) {
  // 0~100, 사람 기준으로 납득 가능한 단순 가중치
  // - CI(60): PASS=60, RUNNING=30, FAIL=10, UNKNOWN=20
  // - Static(20): lint/typecheck/format 성공여부(있으면 더 정확), 없으면 PASS일 때 기본 10
  // - Tests(15): test 성공 여부(있으면), 없으면 PASS일 때 기본 8
  // - Complexity(5): 변경량 기반
  let ciScore = 20;
  if (ci.overall === "PASS") ciScore = 60;
  else if (ci.overall === "RUNNING") ciScore = 30;
  else if (ci.overall === "FAIL") ciScore = 10;

  // check name 기반으로 대충 분류(레포마다 이름이 다를 수 있어 heuristic)
  const byName = (kw) =>
    ci.checks.filter((c) => (c.name || "").toLowerCase().includes(kw));

  const formatChecks = byName("format");
  const lintChecks = byName("lint");
  const typeChecks = byName("type");
  const testChecks = byName("test");

  const isAllSuccess = (arr) =>
    arr.length > 0 && arr.every((c) => c.conclusion === "success");

  const anyFail = (arr) =>
    arr.some((c) =>
      ["failure", "cancelled", "timed_out", "action_required"].includes(
        c.conclusion,
      ),
    );

  // Static(20)
  let staticScore = 0;
  const staticSignals = [
    { name: "format", arr: formatChecks, weight: 7 },
    { name: "lint", arr: lintChecks, weight: 7 },
    { name: "typecheck", arr: typeChecks, weight: 6 },
  ];

  const hasAnyStaticNamed =
    formatChecks.length + lintChecks.length + typeChecks.length > 0;

  if (hasAnyStaticNamed) {
    for (const s of staticSignals) {
      if (isAllSuccess(s.arr)) staticScore += s.weight;
      else if (anyFail(s.arr))
        staticScore += 1; // 실패라도 "존재"는 하므로 최소 점수
      else staticScore += 3; // running/unknown
    }
  } else {
    // 워크플로우가 하나('test')로만 보이는 경우가 많아서, PASS면 기본점
    staticScore = ci.overall === "PASS" ? 10 : 3;
  }

  // Tests(15)
  let testScore = 0;
  const hasTestNamed = testChecks.length > 0;
  if (hasTestNamed) {
    if (isAllSuccess(testChecks)) testScore = 15;
    else if (anyFail(testChecks)) testScore = 2;
    else testScore = 7;
  } else {
    testScore = ci.overall === "PASS" ? 8 : 2;
  }

  // Complexity(5)
  let complexityScore = 5;
  if (stats.linesChanged > 500) complexityScore = 0;
  else if (stats.linesChanged > 200) complexityScore = 2;
  else if (stats.linesChanged > 80) complexityScore = 3;

  // Safety 정책이 강하게 걸리면 “품질”도 보수적으로 깎음(리뷰 필요 영역이니까)
  let penalty = 0;
  if (policy.highRisk) penalty += 5;
  if (policy.tooLarge) penalty += 3;
  if (policy.secretSuspected) penalty += 10;

  let total = ciScore + staticScore + testScore + complexityScore - penalty;
  total = Math.max(0, Math.min(100, total));

  return {
    total,
    breakdown: {
      ci: ciScore,
      static: staticScore,
      tests: testScore,
      complexity: complexityScore,
      penalty,
    },
  };
}

// ---------- labels + comment ----------
function labelsFor(safetyScores, quality, policy, ci) {
  const labels = ["gatekeeper-reviewed", "ai-reviewed"];

  if (safetyScores.safety >= 96) labels.push("ai-safe-96plus");
  else if (safetyScores.safety >= 90) labels.push("ai-safe-90plus");
  else labels.push("ai-safe-below-90");

  if (policy.highRisk || policy.tooLarge || policy.secretSuspected)
    labels.push("ai-review-required");
  else labels.push("ai-review-optional");

  // CI 라벨(선택): 보기 편하니까 추천
  if (ci.overall === "PASS") labels.push("ci-pass");
  else if (ci.overall === "FAIL") labels.push("ci-fail");
  else if (ci.overall === "RUNNING") labels.push("ci-running");
  else labels.push("ci-unknown");

  // 품질 라벨(선택)
  if (quality.total >= 95) labels.push("quality-95plus");
  else if (quality.total >= 85) labels.push("quality-85plus");
  else labels.push("quality-below-85");

  if (policy.secretSuspected) labels.push("ai-review-skipped-secrets");
  if (policy.tooLarge) labels.push("ai-review-summary-only");

  return labels;
}

function renderCiLines(ci) {
  if (!ci || ci.checks.length === 0) return "- (no checks found)";
  const lines = ci.checks.slice(0, 10).map((c) => {
    const concl = c.conclusion === "unknown" ? c.status : c.conclusion;
    return `- ${c.name}: ${concl}`;
  });

  // 실패 원인(steps)
  if (ci.failureHints && ci.failureHints.length > 0) {
    lines.push("");
    lines.push("**Failure hints (Actions step)**");
    for (const h of ci.failureHints.slice(0, 3)) {
      lines.push(`- ${h.job} → ${h.step} (${h.conclusion})`);
    }
  }
  return lines.join("\n");
}

function buildComment({
  prNumber,
  safetyScores,
  quality,
  policy,
  stats,
  baseSha,
  headSha,
  ci,
}) {
  const decision =
    ci.overall === "FAIL" ||
    policy.highRisk ||
    policy.tooLarge ||
    policy.secretSuspected ||
    safetyScores.safety < 90
      ? "NEEDS_REVIEW"
      : "SAFE";

  const reasons = policy.reasons.length
    ? policy.reasons.map((r) => `- ${r}`).join("\n")
    : "- none";

  return `${MARKER}

### Summary
- PR: #${prNumber}
- CI: **${ci.overall}**
- Safety Score: **${safetyScores.safety}/100** (Risk ${safetyScores.risk}/100)
- Code Quality Score: **${quality.total}/100** (CI ${quality.breakdown.ci} / Static ${quality.breakdown.static} / Tests ${quality.breakdown.tests} / Complexity ${quality.breakdown.complexity} - Penalty ${quality.breakdown.penalty})
- Decision: **${decision}**
- High-Risk 영역: ${policy.highRisk ? "YES" : "NO"}
- Diff too large: ${policy.tooLarge ? "YES" : "NO"}
- Secret suspected: ${policy.secretSuspected ? "YES" : "NO"}

### CI Details
${renderCiLines(ci)}

### Policy Reasons
${reasons}

### Diff Stats
- base: \`${baseSha.slice(0, 7)}\`
- head: \`${headSha.slice(0, 7)}\`
- files changed: ${stats.filesChanged}
- lines changed: ${stats.linesChanged} (add ${stats.additions}, del ${stats.deletions})

### Suggested Next Checks
- [ ] CI가 FAIL이면 먼저 CI부터 해결 (예: format/lint/typecheck/test)
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

  // WP3: CI summary
  const ci = await getCiSummary(token, owner, repo, headSha);

  // Safety + Quality
  const policy = evaluatePolicy({
    fileNames,
    linesChanged,
    filesChanged,
    keywords: highRiskKeywords,
    maxFiles,
    maxDiffLines,
    combinedPatch,
  });

  const safetyScores = computeSafetyScores({
    linesChanged,
    filesChanged,
    policy,
  });
  const quality = computeQualityScore({
    ci,
    stats: { linesChanged, filesChanged },
    policy,
  });

  const labels = labelsFor(safetyScores, quality, policy, ci);

  const commentBody = buildComment({
    prNumber,
    safetyScores,
    quality,
    policy,
    stats: { filesChanged, linesChanged, additions, deletions },
    baseSha,
    headSha,
    ci,
  });

  await upsertComment(token, owner, repo, prNumber, commentBody);
  await upsertLabels(token, owner, repo, prNumber, labels);

  console.log("Gatekeeper OK:", {
    prNumber,
    safetyScores,
    quality,
    policy,
    ciOverall: ci.overall,
    labels,
  });
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
  const managedPrefixes = ["ai-", "gatekeeper-", "ci-", "quality-"];

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
