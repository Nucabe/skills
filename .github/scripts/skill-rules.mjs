// Rules every SKILL.md must follow. Used by validate-skills.mjs on pull
// requests and by notion-sync.mjs before it opens one.

export const TEAM_PREFIXES = ["design-", "marketing-", "cp-", "general-"];
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

export function hasSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

// Returns { errors: [], warnings: [] } for one skill's SKILL.md text.
export function checkSkill(folder, text) {
  const errors = [];
  const warnings = [];
  const fm = frontmatter(text);
  if (!fm) {
    errors.push("SKILL.md must start with frontmatter between two --- lines");
    return { errors, warnings };
  }

  if (!fm.name) errors.push("frontmatter is missing name");
  else if (fm.name !== folder)
    errors.push(`name "${fm.name}" must match the folder name "${folder}"`);

  if (!NAME_PATTERN.test(folder))
    errors.push("folder name must be lowercase words joined by hyphens");

  if (!TEAM_PREFIXES.some((p) => folder.startsWith(p)))
    warnings.push(`name has no team prefix (${TEAM_PREFIXES.join(", ")}). Fine for engineering skills; otherwise add one.`);

  if (!fm.description) errors.push("frontmatter is missing description");
  else if (fm.description.length > 1024)
    errors.push("description must be 1024 characters or fewer");
  else if (/: /.test(fm.description) && !/^["']/.test(fm.description))
    errors.push('description contains ": ", which breaks YAML. Put the description in double quotes.');

  if ("model" in fm)
    errors.push("do not set model in the frontmatter (see Rules in README.md)");

  if (hasSecret(text))
    errors.push("looks like it contains a credential, token or key. Remove it.");

  return { errors, warnings };
}
