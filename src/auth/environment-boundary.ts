import * as fs from "node:fs";
import * as path from "node:path";

export interface CredentialEnvironmentOptions {
  cwd?: () => string;
  env?: Readonly<Record<string, string | undefined>>;
  warn?: (message: string) => void;
}

function isInside(targetDir: string, cwd: string): boolean {
  try {
    const target = fs.realpathSync.native(targetDir);
    const current = fs.realpathSync.native(cwd);
    const relative = path.relative(target, current);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  } catch {
    return true;
  }
}

/**
 * Snapshot operator environment before target code can mutate it, and deny
 * lookups whenever the current process cwd enters the target boundary.
 */
export function createCredentialEnvironment(
  targetDir: string,
  options: CredentialEnvironmentOptions = {},
): (name: string) => string | undefined {
  const cwd = options.cwd ?? (() => process.cwd());
  const initialCwd = cwd();
  const initiallyBlocked = isInside(targetDir, initialCwd);
  const snapshot = initiallyBlocked ? {} : { ...(options.env ?? process.env) };
  if (initiallyBlocked)
    options.warn?.(
      `ad-coder: environment credentials disabled because process cwd is inside --target-dir ` +
        `(${targetDir}); run from an external directory for env-var providers\n`,
    );
  return (name: string) => (isInside(targetDir, cwd()) ? undefined : snapshot[name]);
}
