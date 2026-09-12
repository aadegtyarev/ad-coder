import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version?: unknown;
};
if (
  typeof manifest.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
)
  throw new Error("package.json version must be valid SemVer");

const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const escapedVersion = manifest.version.replaceAll(".", "\\.");
const release = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
if (!release.test(changelog))
  throw new Error(`CHANGELOG.md has no dated heading for package version ${manifest.version}`);

process.stdout.write(`release metadata valid: ${manifest.version}\n`);
