import fs from "node:fs/promises";
import path from "node:path";

function mustString(v, name) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Invalid ${name}`);
  return v.trim();
}

function asStringArray(v, name) {
  if (!Array.isArray(v)) throw new Error(`Invalid ${name}`);
  const out = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) out.push(x.trim());
  }
  return out;
}

function formatBullets(lines) {
  return lines.length ? lines.map((s) => `- ${s}`).join("\n") : "- (none)";
}

function renderTaskMd({ wp, wpPath }) {
  const id = mustString(wp.id, "id");
  const title = mustString(wp.title, "title");
  const epic = typeof wp.epic === "string" ? wp.epic.trim() : "";
  const desc =
    wp?.task && typeof wp.task.description === "string"
      ? wp.task.description.trim()
      : "";

  const ac = asStringArray(
    wp?.task?.acceptance_criteria,
    "acceptance_criteria",
  );
  const dod = asStringArray(wp.definition_of_done, "definition_of_done");
  const covers = asStringArray(wp.covers, "covers");
  const files = asStringArray(wp.files, "files");

  const coversLine = covers.length ? covers.join(", ") : "(none)";

  return [
    "# TASK",
    "",
    "## Context",
    epic ? `- Epic: ${epic}` : "- Epic: (none)",
    `- Work-packet: ${id} - ${title}`,
    `- Source: ${wpPath}`,
    covers.length ? `- Covers: ${coversLine}` : `- Covers: ${coversLine}`,
    "",
    "## Goal",
    desc ? desc : "(no description provided)",
    "",
    "## Acceptance Criteria",
    formatBullets(ac),
    "",
    "## Definition of Done",
    formatBullets(dod),
    "",
    "## Files to create",
    // coding-agent는 이 섹션을 파싱해서 diff에 포함 강제함
    // files가 비어도 문제 없음(강제 없음)
    formatBullets(files),
    "",
  ].join("\n");
}

async function main() {
  const wpPath = process.argv[2];
  const outPath = process.argv[3] ?? ".ai/TASK.md";
  if (!wpPath) {
    console.error(
      "Usage: node scripts/wp-to-task.mjs <work-packet.json> [out]",
    );
    process.exit(2);
  }

  const absWp = path.resolve(wpPath);
  const raw = await fs.readFile(absWp, "utf8");
  const wp = JSON.parse(raw);

  const md = renderTaskMd({ wp, wpPath });
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, md, "utf8");
  console.log(`[wp-to-task] wrote ${outPath} from ${wpPath}`);
}

main().catch((e) => {
  console.error("[wp-to-task] failed:", e?.message || e);
  process.exit(1);
});
