// Copies skills from the Notion AI Skills databases into pull requests.
//
// For each page whose Status is "Ready for review":
//   - takes the first code block on the page that starts with frontmatter
//     (--- name: ...), sets its name to the page's Command, and checks it
//   - writes it to <Command>/SKILL.md on the branch notion/<Command>
//   - opens a pull request (or updates the open one) and sets Status to
//     "In review" with the pull request link in the GitHub column
// For each page whose Status is "In review":
//   - sets Status to "Live" once the pull request is merged, or "Needs fix"
//     if it was closed without merging
// Problems are posted as a comment on the Notion page and Status is set to
// "Needs fix". Set it back to "Ready for review" after fixing the page.
//
// Env: NOTION_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo).
// NOTION_API and GITHUB_API can point at a test server.

import { readFileSync } from "node:fs";
import { checkSkill } from "./skill-rules.mjs";

const NOTION_API = process.env.NOTION_API || "https://api.notion.com/v1";
const GITHUB_API = process.env.GITHUB_API || "https://api.github.com";
const NOTION_VERSION = "2025-09-03";
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || "").split("/");
const { sources } = JSON.parse(
  readFileSync(new URL("../notion-sources.json", import.meta.url), "utf8"),
);

if (!process.env.NOTION_TOKEN) {
  console.log("NOTION_TOKEN is not set; nothing to sync.");
  process.exit(0);
}

async function call(base, headers, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`${method} ${path}: ${res.status} ${data.message || text}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const notion = (method, path, body) =>
  call(NOTION_API, {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
  }, method, path, body);

const github = (method, path, body) =>
  call(GITHUB_API, {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  }, method, `/repos/${OWNER}/${REPO}${path}`, body);

const plain = (richText = []) => richText.map((t) => t.plain_text).join("");

async function pagesWithStatus(dataSourceId, status) {
  const pages = [];
  let cursor;
  do {
    const data = await notion("POST", `/data_sources/${dataSourceId}/query`, {
      filter: { property: "Status", select: { equals: status } },
      start_cursor: cursor,
    });
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// Code blocks on the page, including inside toggles and columns.
async function codeBlocks(blockId, out = []) {
  let cursor;
  do {
    const q = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const data = await notion("GET", `/blocks/${blockId}/children${q}`);
    for (const block of data.results) {
      if (block.type === "code") out.push(plain(block.code.rich_text));
      else if (block.has_children && !["child_page", "child_database"].includes(block.type))
        await codeBlocks(block.id, out);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function setStatus(page, status, githubUrl) {
  const properties = { Status: { select: { name: status } } };
  if (githubUrl) properties.GitHub = { url: githubUrl };
  await notion("PATCH", `/pages/${page.id}`, { properties });
}

async function comment(page, text) {
  await notion("POST", "/comments", {
    parent: { page_id: page.id },
    rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }],
  });
}

async function needsFix(page, reason) {
  console.log(`  needs fix: ${reason}`);
  await comment(page, `Skills sync: ${reason}\n\nFix the page, then set Status back to "Ready for review".`);
  await setStatus(page, "Needs fix");
}

// Puts the page's Command in the name line and quotes a description that
// would otherwise break YAML.
function normalise(skill, command) {
  const text = skill.replace(/\r\n/g, "\n").trim() + "\n";
  const end = text.indexOf("\n---\n", 4);
  let head = text.slice(0, end);
  const body = text.slice(end);
  head = /^name:.*$/m.test(head)
    ? head.replace(/^name:.*$/m, `name: ${command}`)
    : head.replace(/^---\n/, `---\nname: ${command}\n`);
  head = head.replace(/^description:\s*(.*)$/m, (line, value) =>
    /^["']/.test(value) || !/: /.test(value) ? line : `description: ${JSON.stringify(value)}`);
  return head + body;
}

async function fileOn(ref, path) {
  try {
    const data = await github("GET", `/contents/${path}?ref=${encodeURIComponent(ref)}`);
    return { sha: data.sha, text: Buffer.from(data.content, "base64").toString("utf8") };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function publish(page, source, base) {
  const props = page.properties;
  const title = plain(props.Name?.title) || "Untitled";
  const command = plain(props.Command?.rich_text).trim().replace(/^\//, "");
  console.log(`- ${title} (${command || "no command"})`);

  if (!command) return needsFix(page, "the Command column is empty. Add the command name, such as design-eow-summary.");
  if (!command.startsWith(source.prefix))
    return needsFix(page, `the command must start with "${source.prefix}" in the ${source.team} database.`);

  const blocks = await codeBlocks(page.id);
  const skill = blocks.find((b) => /^---\s*\n[\s\S]*?\n---\s*\n/.test(b.replace(/\r\n/g, "\n").trimStart()));
  if (!skill)
    return needsFix(page, 'no skill found. Put the SKILL.md in a code block on the page, starting with "---", then "name:" and "description:" lines, then "---".');

  const text = normalise(skill.trimStart(), command);
  const { errors } = checkSkill(command, text);
  if (errors.length) return needsFix(page, errors.join("; "));

  const path = `${command}/SKILL.md`;
  const branch = `notion/${command}`;
  const owners = (props.Ownership?.multi_select || []).map((o) => o.name).join(", ") || "not set";

  const live = await fileOn(base.name, path);
  if (live && live.text === text) {
    console.log("  already matches main");
    return setStatus(page, "Live", `https://github.com/${OWNER}/${REPO}/blob/${base.name}/${path}`);
  }

  try {
    await github("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: base.sha });
  } catch (e) {
    if (e.status !== 422) throw e; // branch already exists
  }
  const onBranch = await fileOn(branch, path);
  if (!onBranch || onBranch.text !== text) {
    await github("PUT", `/contents/${path}`, {
      message: `${live ? "Update" : "Add"} ${command} from Notion`,
      content: Buffer.from(text).toString("base64"),
      branch,
      sha: onBranch?.sha,
    });
  }

  const open = await github("GET", `/pulls?state=open&head=${OWNER}:${encodeURIComponent(branch)}`);
  const pr = open[0] || await github("POST", "/pulls", {
    title: `${live ? "Update" : "Add"} /${command}`,
    head: branch,
    base: base.name,
    body: [
      `Synced from Notion: ${page.url}`,
      "",
      `Owner: ${owners}`,
      "",
      "To change this skill, edit the Notion page and set its Status to \"Ready for review\" again; this pull request updates on the next sync. Edits made here on GitHub are overwritten.",
    ].join("\n"),
  });
  console.log(`  pull request: ${pr.html_url}`);
  await setStatus(page, "In review", pr.html_url);
}

async function checkReview(page) {
  const command = plain(page.properties.Command?.rich_text).trim();
  if (!command) return;
  const prs = await github("GET", `/pulls?state=all&head=${OWNER}:${encodeURIComponent(`notion/${command}`)}`);
  const pr = prs[0];
  if (!pr || pr.state === "open") return;
  if (pr.merged_at) {
    console.log(`- ${command}: merged, now live`);
    const { default_branch } = await github("GET", "");
    await setStatus(page, "Live", `https://github.com/${OWNER}/${REPO}/blob/${default_branch}/${command}/SKILL.md`);
    await github("DELETE", `/git/refs/heads/notion/${command}`).catch(() => {});
  } else {
    await needsFix(page, `the pull request was closed without merging: ${pr.html_url}. Read the comments there.`);
  }
}

const repo = await github("GET", "");
const ref = await github("GET", `/git/ref/heads/${repo.default_branch}`);
const base = { name: repo.default_branch, sha: ref.object.sha };

let failures = 0;
for (const source of sources) {
  console.log(`${source.team}:`);
  for (const [status, handle] of [["Ready for review", (p) => publish(p, source, base)], ["In review", checkReview]]) {
    for (const page of await pagesWithStatus(source.dataSourceId, status)) {
      try {
        await handle(page);
      } catch (e) {
        failures++;
        console.log(`::error::${page.url}: ${e.message}`);
      }
    }
  }
}
process.exitCode = failures ? 1 : 0;
