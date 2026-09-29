// Checks every <folder>/SKILL.md against the rules in README.md.
// Errors fail the check; warnings show as annotations on the pull request.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkSkill, hasSecret } from "./skill-rules.mjs";

let errors = 0;
const error = (file, msg) => {
  errors++;
  console.log(`::error file=${file}::${msg}`);
};
const warn = (file, msg) => console.log(`::warning file=${file}::${msg}`);

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

  const result = checkSkill(folder, readFileSync(file, "utf8"));
  result.errors.forEach((msg) => error(file, msg));
  result.warnings.forEach((msg) => warn(file, msg));

  // SKILL.md itself was checked above; scan the supporting files too.
  for (const path of walk(folder)) {
    const shown = path.replaceAll("\\", "/");
    if (shown === file) continue;
    if (hasSecret(readFileSync(path, "utf8")))
      error(shown, "looks like it contains a credential, token or key. Remove it.");
  }
}

console.log(`Checked ${folders.length} skills, ${errors} error(s).`);
process.exit(errors ? 1 : 0);
