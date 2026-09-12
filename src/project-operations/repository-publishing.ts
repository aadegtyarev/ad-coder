import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PublishingGate,
  PublishingMode,
  RepositoryPublishingConfig,
} from "../project-store/types";
import { ProjectOperationsError } from "./errors";

export interface PublishingCommandRequest {
  argv: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  outputByteLimit: number;
}

export interface PublishingCommandResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export interface PublishingCommandExecutor {
  execute(request: PublishingCommandRequest): PublishingCommandResult;
}

export interface ResolvedPublishingConfig {
  remote: string;
  baseCandidates: string[];
  protectedBases: string[];
  featurePrefix: string;
  mode: PublishingMode;
  gate: PublishingGate;
  localTestCommand: string[];
  multiDeveloper: boolean;
  outputByteLimit: number;
}

export const DEFAULT_REPOSITORY_PUBLISHING_CONFIG: ResolvedPublishingConfig = {
  remote: "origin",
  baseCandidates: ["main", "master"],
  protectedBases: ["main", "master"],
  featurePrefix: "feature/",
  mode: "auto",
  gate: "local",
  localTestCommand: ["bun", "test"],
  multiDeveloper: false,
  outputByteLimit: 0,
};

export interface RepositoryPublishingPreflight {
  phase: "preflight";
  gate: PublishingGate;
  mode: "github" | "local";
  githubRepository?: string;
  remote: string;
  base: string;
  baseRef: string;
  baseOid: string;
  currentBranch: string;
  headOid: string;
  dirty: { staged: string[]; unstaged: string[]; untracked: string[] };
  recovery: string[];
}

export interface StartPublishingInput {
  preflight: RepositoryPublishingPreflight;
  featureBranch: string;
}

export interface StartedPublishing extends Omit<RepositoryPublishingPreflight, "phase"> {
  phase: "started";
  featureBranch: string;
  featureStartOid: string;
}

export interface PublishingDescription {
  problem: string;
  audience: string;
  userImpact: string;
  verification: string;
  reviewerVerdict: string;
  pipelineUsage?: Record<string, unknown>;
}

export interface FinishPublishingInput {
  started: StartedPublishing;
  paths: string[];
  commitMessage: string;
  title: string;
  description: PublishingDescription;
  authorizeInitiallyDirtyPaths?: string[];
}

export interface PublishingResult {
  phase: "finished" | "awaiting-manual";
  gate: PublishingGate;
  mode: "github" | "local";
  featureBranch: string;
  featureOid: string;
  base: string;
  baseOid: string;
  prUrl?: string;
  localGate?: { ran: boolean; passed: boolean };
  ciGate?: { ran: boolean; passed: boolean; count: number };
  approval?: { required: boolean; approved: boolean };
  recovery: string[];
}

const REF_PART = /^(?!-)(?!.*\.\.)(?!.*[~^:?*[\\\s])(?!.*\.$)(?!.*\/@)(?!.*\/\/)[A-Za-z0-9._/-]+$/;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GITHUB =
  /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/;

function configError(name: string): never {
  throw new ProjectOperationsError("invalid_config", name);
}

function stringList(value: unknown, name: string, fallback: string[]): string[] {
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !REF_PART.test(entry))
  )
    configError(name);
  return [...new Set(value as string[])];
}

export function resolveRepositoryPublishingConfig(
  supplied: RepositoryPublishingConfig = {},
): ResolvedPublishingConfig {
  const keys = new Set([
    "remote",
    "baseCandidates",
    "protectedBases",
    "featurePrefix",
    "mode",
    "gate",
    "localTestCommand",
    "multiDeveloper",
    "outputByteLimit",
  ]);
  if (Object.keys(supplied).some((key) => !keys.has(key))) configError("publishing");
  const remote = supplied.remote ?? DEFAULT_REPOSITORY_PUBLISHING_CONFIG.remote;
  if (!REMOTE.test(remote)) configError("publishing.remote");
  const mode = supplied.mode ?? DEFAULT_REPOSITORY_PUBLISHING_CONFIG.mode;
  if (!(["auto", "github", "local"] as const).includes(mode)) configError("publishing.mode");
  const gate = supplied.gate ?? DEFAULT_REPOSITORY_PUBLISHING_CONFIG.gate;
  if (!(["local", "ci", "local-and-ci", "manual"] as const).includes(gate))
    configError("publishing.gate");
  const featurePrefix =
    supplied.featurePrefix ?? DEFAULT_REPOSITORY_PUBLISHING_CONFIG.featurePrefix;
  if (!REF_PART.test(`${featurePrefix}x`)) configError("publishing.featurePrefix");
  const command =
    supplied.localTestCommand ?? DEFAULT_REPOSITORY_PUBLISHING_CONFIG.localTestCommand;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.includes("\0"))
  )
    configError("publishing.localTestCommand");
  const outputByteLimit = supplied.outputByteLimit ?? 0;
  if (!Number.isSafeInteger(outputByteLimit) || outputByteLimit < 0)
    configError("publishing.outputByteLimit");
  if (supplied.multiDeveloper !== undefined && typeof supplied.multiDeveloper !== "boolean")
    configError("publishing.multiDeveloper");
  return {
    remote,
    baseCandidates: stringList(
      supplied.baseCandidates,
      "publishing.baseCandidates",
      DEFAULT_REPOSITORY_PUBLISHING_CONFIG.baseCandidates,
    ),
    protectedBases: stringList(
      supplied.protectedBases,
      "publishing.protectedBases",
      DEFAULT_REPOSITORY_PUBLISHING_CONFIG.protectedBases,
    ),
    featurePrefix,
    mode,
    gate,
    localTestCommand: [...command],
    multiDeveloper: supplied.multiDeveloper ?? false,
    outputByteLimit,
  };
}

function run(
  executor: PublishingCommandExecutor,
  cwd: string,
  config: ResolvedPublishingConfig,
  argv: string[],
  options: { stdin?: string; env?: Record<string, string>; allowFailure?: boolean } = {},
): PublishingCommandResult {
  const result = executor.execute({
    argv,
    cwd,
    outputByteLimit: config.outputByteLimit,
    ...(options.stdin !== undefined && { stdin: options.stdin }),
    ...(options.env !== undefined && { env: options.env }),
  });
  if (result.exitCode !== 0 && !options.allowFailure)
    throw new ProjectOperationsError("publish_failed", argv.slice(0, 3).join(" "));
  return result;
}

function git(
  executor: PublishingCommandExecutor,
  cwd: string,
  config: ResolvedPublishingConfig,
  args: string[],
  allowFailure = false,
): PublishingCommandResult {
  return run(executor, cwd, config, ["git", ...args], { allowFailure });
}

function output(result: PublishingCommandResult): string {
  return result.stdout.trim();
}

function recovery(feature: string): string[] {
  return [
    `git switch ${feature}`,
    "git status --short",
    "Resolve the reported condition, then rerun publish-finish with a fresh preflight if the base moved.",
  ];
}

function parseStatus(raw: string): RepositoryPublishingPreflight["dirty"] {
  const dirty = { staged: [] as string[], unstaged: [] as string[], untracked: [] as string[] };
  for (const record of raw.split("\0").filter(Boolean)) {
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (code === "??") dirty.untracked.push(file);
    else {
      if (code[0] !== " ") dirty.staged.push(file);
      if (code[1] !== " ") dirty.unstaged.push(file);
    }
  }
  return dirty;
}

function githubRepository(url: string): string | undefined {
  return GITHUB.exec(url.trim())?.[1];
}

export function preflightRepositoryPublishing(
  executor: PublishingCommandExecutor,
  cwd: string,
  supplied: RepositoryPublishingConfig = {},
): RepositoryPublishingPreflight {
  const config = resolveRepositoryPublishingConfig(supplied);
  const inside = git(executor, cwd, config, ["rev-parse", "--is-inside-work-tree"], true);
  if (inside.exitCode !== 0 || output(inside) !== "true")
    throw new ProjectOperationsError("not_repository", path.basename(cwd));
  const currentBranch = output(
    git(executor, cwd, config, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
  );
  const headOid = output(git(executor, cwd, config, ["rev-parse", "HEAD"]));
  const remoteUrlResult = git(executor, cwd, config, ["remote", "get-url", config.remote], true);
  const repository =
    remoteUrlResult.exitCode === 0 ? githubRepository(remoteUrlResult.stdout) : undefined;
  let mode: "github" | "local";
  if (config.mode === "github") {
    if (repository === undefined)
      throw new ProjectOperationsError("github_unavailable", config.remote);
    mode = "github";
  } else mode = config.mode === "local" ? "local" : repository === undefined ? "local" : "github";
  if (mode === "local" && config.multiDeveloper)
    throw new ProjectOperationsError("approval_required", "GitHub mode");

  let base: string | undefined;
  let baseRef: string | undefined;
  if (remoteUrlResult.exitCode === 0) {
    const symbolic = git(
      executor,
      cwd,
      config,
      ["symbolic-ref", "--quiet", `refs/remotes/${config.remote}/HEAD`],
      true,
    );
    if (symbolic.exitCode === 0) {
      const candidate = output(symbolic).replace(`refs/remotes/${config.remote}/`, "");
      if (REF_PART.test(candidate)) {
        base = candidate;
        baseRef = `refs/remotes/${config.remote}/${candidate}`;
      }
    }
  }
  if (base === undefined) {
    for (const candidate of config.baseCandidates) {
      const refs =
        remoteUrlResult.exitCode === 0
          ? [`refs/remotes/${config.remote}/${candidate}`, `refs/heads/${candidate}`]
          : [`refs/heads/${candidate}`];
      for (const ref of refs) {
        if (
          git(executor, cwd, config, ["show-ref", "--verify", "--quiet", ref], true).exitCode === 0
        ) {
          base = candidate;
          baseRef = ref;
          break;
        }
      }
      if (base !== undefined) break;
    }
  }
  if (base === undefined || baseRef === undefined)
    throw new ProjectOperationsError("not_found", "base ref");
  const baseOid = output(git(executor, cwd, config, ["rev-parse", baseRef]));
  const dirty = parseStatus(
    git(executor, cwd, config, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout,
  );
  return {
    phase: "preflight",
    gate: config.gate,
    mode,
    ...(repository !== undefined && { githubRepository: repository }),
    remote: config.remote,
    base,
    baseRef,
    baseOid,
    currentBranch,
    headOid,
    dirty,
    recovery: recovery(currentBranch),
  };
}

function requireFeature(branch: string, config: ResolvedPublishingConfig): void {
  if (
    !REF_PART.test(branch) ||
    !branch.startsWith(config.featurePrefix) ||
    config.protectedBases.includes(branch)
  )
    configError("featureBranch");
}

function validateSnapshot(snapshot: RepositoryPublishingPreflight | StartedPublishing): void {
  if (
    !REF_PART.test(snapshot.base) ||
    !REF_PART.test(snapshot.currentBranch) ||
    !REF_PART.test(snapshot.baseRef) ||
    snapshot.baseRef.startsWith("-") ||
    !/^[0-9a-f]{40,64}$/.test(snapshot.baseOid) ||
    !/^[0-9a-f]{40,64}$/.test(snapshot.headOid)
  )
    throw new ProjectOperationsError("invalid_config", "publishing snapshot");
  if (!REMOTE.test(snapshot.remote))
    throw new ProjectOperationsError("invalid_config", "publishing snapshot remote");
  if (
    !("gate" in snapshot) ||
    !(["local", "ci", "local-and-ci", "manual"] as const).includes(snapshot.gate) ||
    !(["github", "local"] as const).includes(snapshot.mode) ||
    typeof snapshot.dirty !== "object" ||
    snapshot.dirty === null ||
    [snapshot.dirty.staged, snapshot.dirty.unstaged, snapshot.dirty.untracked].some(
      (entries) => !Array.isArray(entries) || entries.some((entry) => typeof entry !== "string"),
    )
  )
    throw new ProjectOperationsError("invalid_config", "publishing snapshot state");
  if (
    snapshot.githubRepository !== undefined &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(snapshot.githubRepository)
  )
    throw new ProjectOperationsError("invalid_config", "publishing snapshot repository");
}

export function startRepositoryPublishing(
  executor: PublishingCommandExecutor,
  cwd: string,
  input: StartPublishingInput,
  supplied: RepositoryPublishingConfig = {},
): StartedPublishing {
  const config = resolveRepositoryPublishingConfig(supplied);
  validateSnapshot(input.preflight);
  if (input.preflight.gate !== config.gate)
    throw new ProjectOperationsError("invalid_config", "publishing gate changed");
  requireFeature(input.featureBranch, config);
  if (config.protectedBases.includes(input.featureBranch))
    throw new ProjectOperationsError("protected_base", input.featureBranch);
  const observed = preflightRepositoryPublishing(executor, cwd, supplied);
  if (observed.baseOid !== input.preflight.baseOid || observed.baseRef !== input.preflight.baseRef)
    throw new ProjectOperationsError("base_moved", input.preflight.base);
  if (
    observed.headOid !== input.preflight.headOid ||
    observed.currentBranch !== input.preflight.currentBranch
  )
    throw new ProjectOperationsError("publish_failed", "HEAD changed");
  if (observed.headOid !== input.preflight.baseOid)
    throw new ProjectOperationsError("publish_failed", "HEAD is not the selected base");
  git(executor, cwd, config, ["switch", "-c", input.featureBranch]);
  const featureStartOid = output(git(executor, cwd, config, ["rev-parse", "HEAD"]));
  return {
    ...input.preflight,
    phase: "started",
    gate: config.gate,
    featureBranch: input.featureBranch,
    featureStartOid,
    recovery: recovery(input.featureBranch),
  };
}

function currentBranch(
  executor: PublishingCommandExecutor,
  cwd: string,
  config: ResolvedPublishingConfig,
): string {
  const branch = output(git(executor, cwd, config, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  if (config.protectedBases.includes(branch))
    throw new ProjectOperationsError("protected_base", branch);
  return branch;
}

function assertBaseUnchanged(
  executor: PublishingCommandExecutor,
  cwd: string,
  config: ResolvedPublishingConfig,
  started: StartedPublishing,
): void {
  const actual = output(git(executor, cwd, config, ["rev-parse", started.baseRef]));
  if (actual !== started.baseOid) throw new ProjectOperationsError("base_moved", started.base);
}

function validatePaths(cwd: string, input: FinishPublishingInput): string[] {
  if (!Array.isArray(input.paths) || input.paths.length === 0)
    throw new ProjectOperationsError("unauthorized_path", "paths");
  const initial = new Set([
    ...input.started.dirty.staged,
    ...input.started.dirty.unstaged,
    ...input.started.dirty.untracked,
  ]);
  const authorized = new Set(input.authorizeInitiallyDirtyPaths ?? []);
  const result: string[] = [];
  for (const file of input.paths) {
    if (
      typeof file !== "string" ||
      file === "" ||
      path.isAbsolute(file) ||
      file.split(/[\\/]/).includes("..") ||
      file.startsWith("-")
    )
      throw new ProjectOperationsError("unauthorized_path", "path");
    try {
      if (fs.lstatSync(path.join(cwd, file)).isDirectory())
        throw new ProjectOperationsError("unauthorized_path", file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (initial.has(file) && !authorized.has(file))
      throw new ProjectOperationsError("unauthorized_path", file);
    result.push(file);
  }
  return [...new Set(result)];
}

function buildCommit(
  executor: PublishingCommandExecutor,
  cwd: string,
  config: ResolvedPublishingConfig,
  input: FinishPublishingInput,
): string {
  const branch = currentBranch(executor, cwd, config);
  if (branch !== input.started.featureBranch)
    throw new ProjectOperationsError("publish_failed", "feature branch");
  const old = output(git(executor, cwd, config, ["rev-parse", "HEAD"]));
  const indexName = `ad-coder-publish-index-${process.pid}-${Date.now()}`;
  const resolvedIndex = output(git(executor, cwd, config, ["rev-parse", "--git-path", indexName]));
  const index = path.isAbsolute(resolvedIndex) ? resolvedIndex : path.resolve(cwd, resolvedIndex);
  const env = { GIT_INDEX_FILE: index };
  let commit: string | undefined;
  let failure: unknown;
  try {
    run(executor, cwd, config, ["git", "read-tree", old], { env });
    run(executor, cwd, config, ["git", "add", "--", ...validatePaths(cwd, input)], { env });
    const tree = output(run(executor, cwd, config, ["git", "write-tree"], { env }));
    commit = output(
      run(executor, cwd, config, ["git", "commit-tree", tree, "-p", old], {
        stdin: `${input.commitMessage}\n`,
        env,
      }),
    );
    git(executor, cwd, config, ["update-ref", `refs/heads/${branch}`, commit, old]);
  } catch (error) {
    failure = error;
  }
  fs.rmSync(index, { force: true });
  if (failure !== undefined) throw failure;
  if (commit === undefined) throw new ProjectOperationsError("publish_failed", "commit");
  return commit;
}

export function buildPublishingPrBody(description: PublishingDescription): string {
  const allowed = new Set([
    "problem",
    "audience",
    "userImpact",
    "verification",
    "reviewerVerdict",
    "pipelineUsage",
  ]);
  if (Object.keys(description).some((key) => !allowed.has(key))) configError("description");
  for (const [key, value] of Object.entries(description)) {
    if (key !== "pipelineUsage" && (typeof value !== "string" || value.trim() === ""))
      configError(`description.${key}`);
  }
  const sections = [
    `## What happens / problem\n\n${description.problem}`,
    `## Who needs it\n\n${description.audience}`,
    `## User impact\n\n${description.userImpact}`,
    `## Verification\n\n${description.verification}`,
    `## Pipeline Reviewer verdict\n\n${description.reviewerVerdict}`,
  ];
  if (description.pipelineUsage !== undefined)
    sections.push(
      `## Pipeline usage\n\n\`\`\`json\n${JSON.stringify(description.pipelineUsage, null, 2)}\n\`\`\``,
    );
  return `${sections.join("\n\n")}\n`;
}

function runLocalGate(
  executor: PublishingCommandExecutor,
  cwd: string,
  config: ResolvedPublishingConfig,
): { ran: boolean; passed: boolean } {
  if (config.gate !== "local" && config.gate !== "local-and-ci")
    return { ran: false, passed: false };
  const result = run(executor, cwd, config, config.localTestCommand, { allowFailure: true });
  if (result.exitCode !== 0) throw new ProjectOperationsError("gate_failed", "local");
  return { ran: true, passed: true };
}

interface PrView {
  number: number;
  url: string;
  author: { login: string };
  headRefOid: string;
  baseRefOid: string;
}

export function finishRepositoryPublishing(
  executor: PublishingCommandExecutor,
  cwd: string,
  input: FinishPublishingInput,
  supplied: RepositoryPublishingConfig = {},
): PublishingResult {
  const config = resolveRepositoryPublishingConfig(supplied);
  if (typeof input.commitMessage !== "string" || input.commitMessage.trim() === "")
    throw new ProjectOperationsError("invalid_config", "commitMessage");
  if (typeof input.title !== "string" || input.title.trim() === "")
    throw new ProjectOperationsError("invalid_config", "title");
  if (
    input.authorizeInitiallyDirtyPaths !== undefined &&
    (!Array.isArray(input.authorizeInitiallyDirtyPaths) ||
      input.authorizeInitiallyDirtyPaths.some((entry) => typeof entry !== "string"))
  )
    throw new ProjectOperationsError("invalid_config", "authorizeInitiallyDirtyPaths");
  validateSnapshot(input.started);
  if (input.started.gate !== config.gate)
    throw new ProjectOperationsError("invalid_config", "publishing gate changed");
  requireFeature(input.started.featureBranch, config);
  if (input.started.dirty.staged.length > 0)
    throw new ProjectOperationsError("dirty_index", "preflight index");
  assertBaseUnchanged(executor, cwd, config, input.started);
  const localGate = runLocalGate(executor, cwd, config);
  const featureOid = buildCommit(executor, cwd, config, input);
  assertBaseUnchanged(executor, cwd, config, input.started);
  if (input.started.mode === "local") {
    if (config.multiDeveloper) throw new ProjectOperationsError("approval_required", "GitHub mode");
    if (config.gate === "ci") throw new ProjectOperationsError("gate_failed", "ci unavailable");
    if (config.gate === "manual")
      return {
        phase: "awaiting-manual",
        gate: config.gate,
        mode: "local",
        featureBranch: input.started.featureBranch,
        featureOid,
        base: input.started.base,
        baseOid: input.started.baseOid,
        localGate,
        recovery: recovery(input.started.featureBranch),
      };
    const tree = output(git(executor, cwd, config, ["rev-parse", `${featureOid}^{tree}`]));
    const squash = output(
      run(executor, cwd, config, ["git", "commit-tree", tree, "-p", input.started.baseOid], {
        stdin: `${input.commitMessage}\n`,
      }),
    );
    git(executor, cwd, config, [
      "update-ref",
      `refs/heads/${input.started.base}`,
      squash,
      input.started.baseOid,
    ]);
    return {
      phase: "finished",
      gate: config.gate,
      mode: "local",
      featureBranch: input.started.featureBranch,
      featureOid,
      base: input.started.base,
      baseOid: squash,
      localGate,
      recovery: recovery(input.started.featureBranch),
    };
  }

  currentBranch(executor, cwd, config);
  git(executor, cwd, config, [
    "push",
    input.started.remote,
    `HEAD:refs/heads/${input.started.featureBranch}`,
  ]);
  const repository = input.started.githubRepository;
  if (repository === undefined)
    throw new ProjectOperationsError("github_unavailable", input.started.remote);
  const body = buildPublishingPrBody(input.description);
  run(
    executor,
    cwd,
    config,
    [
      "gh",
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      input.started.base,
      "--head",
      input.started.featureBranch,
      "--title",
      input.title,
      "--body-file",
      "-",
    ],
    { stdin: body },
  );
  const pr = JSON.parse(
    run(executor, cwd, config, [
      "gh",
      "pr",
      "view",
      input.started.featureBranch,
      "--repo",
      repository,
      "--json",
      "number,url,author,headRefOid,baseRefOid",
    ]).stdout,
  ) as PrView;
  if (pr.headRefOid !== featureOid || pr.baseRefOid !== input.started.baseOid)
    throw new ProjectOperationsError("base_moved", input.started.base);
  let ciGate = { ran: false, passed: false, count: 0 };
  if (config.gate === "ci" || config.gate === "local-and-ci") {
    const checks = JSON.parse(
      run(executor, cwd, config, [
        "gh",
        "pr",
        "checks",
        input.started.featureBranch,
        "--repo",
        repository,
        "--json",
        "name,state,bucket,link",
      ]).stdout,
    ) as Array<{ state?: string; bucket?: string }>;
    const passed =
      checks.length > 0 &&
      checks.every((check) => check.state === "SUCCESS" || check.bucket === "pass");
    ciGate = { ran: true, passed, count: checks.length };
    if (!passed) throw new ProjectOperationsError("gate_failed", "ci");
  }
  const approval = { required: config.multiDeveloper, approved: !config.multiDeveloper };
  if (config.multiDeveloper) {
    const protection = run(
      executor,
      cwd,
      config,
      [
        "gh",
        "api",
        `repos/${repository}/branches/${encodeURIComponent(input.started.base)}/protection/required_pull_request_reviews`,
      ],
      { allowFailure: true },
    );
    if (protection.exitCode !== 0)
      throw new ProjectOperationsError("approval_required", "server-enforced review");
    const reviews = JSON.parse(
      run(executor, cwd, config, ["gh", "api", `repos/${repository}/pulls/${pr.number}/reviews`])
        .stdout,
    ) as Array<{ state: string; user?: { login: string }; commit_id?: string }>;
    approval.approved = reviews.some(
      (review) =>
        review.state === "APPROVED" &&
        review.user?.login !== pr.author.login &&
        review.commit_id === featureOid,
    );
    if (!approval.approved)
      throw new ProjectOperationsError("approval_required", "external developer");
  }
  if (config.gate === "manual")
    return {
      phase: "awaiting-manual",
      gate: config.gate,
      mode: "github",
      featureBranch: input.started.featureBranch,
      featureOid,
      base: input.started.base,
      baseOid: input.started.baseOid,
      prUrl: pr.url,
      localGate,
      ciGate,
      approval,
      recovery: recovery(input.started.featureBranch),
    };
  const current = JSON.parse(
    run(executor, cwd, config, [
      "gh",
      "pr",
      "view",
      input.started.featureBranch,
      "--repo",
      repository,
      "--json",
      "headRefOid,baseRefOid",
    ]).stdout,
  ) as Pick<PrView, "headRefOid" | "baseRefOid">;
  if (current.headRefOid !== featureOid || current.baseRefOid !== input.started.baseOid)
    throw new ProjectOperationsError("base_moved", input.started.base);
  currentBranch(executor, cwd, config);
  run(executor, cwd, config, [
    "gh",
    "pr",
    "merge",
    input.started.featureBranch,
    "--repo",
    repository,
    "--squash",
    "--match-head-commit",
    featureOid,
  ]);
  return {
    phase: "finished",
    gate: config.gate,
    mode: "github",
    featureBranch: input.started.featureBranch,
    featureOid,
    base: input.started.base,
    baseOid: input.started.baseOid,
    prUrl: pr.url,
    localGate,
    ciGate,
    approval,
    recovery: recovery(input.started.featureBranch),
  };
}
