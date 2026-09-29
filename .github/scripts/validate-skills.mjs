// Checks every <folder>/SKILL.md against the rules in README.md.
// Errors fail the check; warnings show as annotations on the pull request.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const TEAM_PREFIXES = ["design-", "marketing-", "cp-", "general-"];
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsecret_[A-Za-z0-9]{40,}\b/,
  /\bntn_[A-Za-z0-9]{40,}\b/,
];

let errors = 0;
const error = (file, msg) => {
  errors++;
  console.log(`::error file=${file}::${msg}`);
};
const warn = (file, msg) => console.log(`::warning file=${file}::${msg}`);

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const folders = readdirSync(".").filter(
  (d) => !d.startsWith(".") && statSync(d).isDirectory(),
);

for (const folder of folders) {
  const file = `${folder}/SKILL.md`;
  if (!existsSync(file)) {
    error(folder, `${folder}/ has no SKILL.md`);
    continue;
  }

  const fm = frontmatter(readFileSync(file, "utf8"));
  if (!fm) {
    error(file, "SKILL.md must start with frontmatter between two --- lines");
    continue;
  }

  if (!fm.name) error(file, "frontmatter is missing name");
  else if (fm.name !== folder)
    error(file, `name "${fm.name}" must match the folder name "${folder}"`);

  if (!NAME_PATTERN.test(folder))
    error(file, "folder name must be lowercase words joined by hyphens");

  if (!TEAM_PREFIXES.some((p) => folder.startsWith(p)))
    warn(file, `name has no team prefix (${TEAM_PREFIXES.join(", ")}). Fine for engineering skills; otherwise add one.`);

  if (!fm.description) error(file, "frontmatter is missing description");
  else if (fm.description.length > 1024)
    error(file, "description must be 1024 characters or fewer");

  if ("model" in fm)
    error(file, "do not set model in the frontmatter (see Rules in README.md)");

  for (const path of walk(folder)) {
    const content = readFileSync(path, "utf8");
    const shown = path.replaceAll("\\", "/");
    if (SECRET_PATTERNS.some((re) => re.test(content)))
      error(shown, "looks like it contains a credential, token or key. Remove it.");
  }
}

console.log(`Checked ${folders.length} skills, ${errors} error(s).`);
process.exit(errors ? 1 : 0);
