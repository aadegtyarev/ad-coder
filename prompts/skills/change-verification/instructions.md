Decide whether a change is correct by attacking it, not by reading it approvingly.

The author is blind exactly where they erred: the reasoning that produced a bug
also hides it. Whoever verifies does not share that blind spot — which is why
attacking the change is the verifier's job and not the writer's. A dedicated
reviewer usually holds it; an orchestrator accepting a delegate's work applies
the same technique to the same standard.

## Start from what the change claims

Read the task, the diff, prior findings and the named contracts. Reconstruct the
intended consumer — human or machine — their job, and the observable outcome.
Then check that every affected surface was considered and that the happy path,
the waiting path, failure and recovery, compatibility, documentation and release
behaviour all agree with each other.

Discover the enforceable contracts yourself rather than trusting a planner's
selection or compression. A contract violation is blocking even when every test
passes. Contract silence on an affected surface is a finding, not implicit
approval.

## Judge on output, never on appearance

An acceptance criterion passes only with captured evidence. Never mark one
passed because the code looks like it should work — that is the single most
common way a broken change ships.

Run the focused test first and the full required suite once. If the command was
not given to you, rediscover it from the project — scripts, `Makefile`, CI, the
README — rather than skipping the check, and name what you ran in the evidence.
Do not rerun an unchanged passing suite while investigating a separate finding.

## Try to break it

Attack boundaries, absent and malformed input, wrong shapes, scale, and
concurrency — two calls at once against shared state, if the change touches any.
How many vectors you try scales with complexity: one or two for a trivial
change, more for a complex one. Every exploit a threat model named gets run
regardless of how the diff looks.

Every break must be reproducible: the exact command and its captured output go
in the finding. A crash you can trigger is a finding; one you suspect is a
guess, and guesses do not belong in a verdict.

Check that expected failures stay distinguishable from one another, safe,
actionable to a human, stable for a machine caller, and non-successful at the
process boundary.

## Prove the test would have caught the defect

When a behaviour change ships with a test: save the diff, revert only the
non-test code, and run the test. **It must fail.** If it still passes against
the old code, the test is decoration — report that as a blocker.

Then restore the diff and confirm the tree is exactly as you found it. If the
revert or the restore fails, stop and report it rather than leaving the tree
half-reverted. Capture both runs as evidence. A test never seen to go red proves
nothing.

This is the one step that cannot be replaced by reading. A test written from the
same misunderstanding as the code passes against both.

## Read the code as code

Correctness, compliance with the plan, simplification, efficiency. Block new or
worsened low-cohesion functions and modules, unjustified size, and comments that
narrate syntax, repeat types, have gone stale, or stand in for a clearer name or
an extraction. Preserve comments that carry non-obvious rationale or risk.

For a decomposition or boundary change, require a diagnosed structural problem,
characterization evidence, explicit ownership and dependency direction,
behaviour-preserving steps, and a measurable improvement — without pass-through
modules or public API growth that buy nothing.

When documentation changed, read it once as its intended reader before using
what you know from the source: find the first required action, undefined terms,
hidden prerequisites, contradictory sources, and sections that grew by
accretion. Passing a size gate does not establish clarity. Block prose that is
technically true but makes the reader reconstruct the workflow themselves.

When you were given security mitigations, verify each is actually met in the
change — an unmet mitigation is a blocker, evidenced by what you ran or read,
never by the author's claim.

## The verdict

Approve only when no further change is required. Otherwise state each required
change as one specific, actionable issue with a severity. Base the decision on
what you proved, not on what the author reported.

A refusal costs a round; an approval that should have been a refusal costs
everything downstream of it.
