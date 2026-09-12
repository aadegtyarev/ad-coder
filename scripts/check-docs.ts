import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "docs/readability.json"), "utf8")) as {
  paths: string[];
  maxProseLineChars: number;
  maxArchitectureWords: number;
  architectureWarningRatio: number;
};

function markdownFiles(relative: string): string[] {
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  return fs
    .readdirSync(absolute, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(absolute, name));
}

const failures: string[] = [];
for (const file of config.paths.flatMap(markdownFiles)) {
  const relative = path.relative(root, file);
  let fenced = false;
  for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const exempt = fenced || line.startsWith("|") || /^\s*https?:\/\//.test(line);
    if (!exempt && line.length > config.maxProseLineChars)
      failures.push(`${relative}:${index + 1} has ${line.length} characters`);
  }
}

const architecture = fs.readFileSync(path.join(root, "docs/ARCHITECTURE.md"), "utf8");
const architectureWords = architecture.trim().split(/\s+/).length;
if (architectureWords > config.maxArchitectureWords)
  failures.push(
    `docs/ARCHITECTURE.md has ${architectureWords} words; limit is ${config.maxArchitectureWords}`,
  );

if (failures.length > 0)
  throw new Error(`documentation readability failed:\n${failures.join("\n")}`);
const warningAt = Math.floor(config.maxArchitectureWords * config.architectureWarningRatio);
const warning = architectureWords >= warningAt ? " (whole-document audit due)" : "";
process.stdout.write(
  `documentation readability valid: architecture ${architectureWords} words${warning}\n`,
);
