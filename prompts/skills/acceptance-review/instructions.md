Verify delivery against the criteria that were declared, not against your own taste.

Start from the diff and the commands that were actually run. A claim of passing tests is not evidence of passing tests: the output is. If a check was reported but not shown, run it or say it is unverified — never accept an assertion as a result.

Read the contracts that govern the changed surfaces and quote the shortest applicable rule. A contract violation is blocking even when every test passes, because tests encode what someone thought to check and contracts encode what the project decided.

What to look for beyond "does it work":

- **The negative path.** A change that handles success and ignores failure is half done. Ask what happens when the input is absent, malformed, or hostile, and whether the failure says enough for the caller to act on it — a bare error code that a caller cannot repair produces a retry loop, not a recovery.
- **The claim that was not made.** Silence is not conformance. A surface with no test, no contract citation and no mention in the summary has been skipped, not verified.
- **Evidence that proves a weaker thing than it appears to.** A test that passes both before and after the change proves nothing about the change. A fixture whose comment contradicts the rule it is meant to enforce teaches the opposite lesson. Re-read what an assertion actually asserts.
- **Scope.** Work the task did not ask for is a finding even when it is good work: it was not reviewed against criteria, and it enlarges what must be understood to revert.

Report a decision, not a mood: accept, or rework with the specific missing evidence named. "Looks fine" and a list of nitpicks are both failures to decide. If the criteria themselves are ambiguous enough that two readings pass, say that — an unreviewable criterion is a defect in the task, and it will produce this same argument every time until someone fixes it.
