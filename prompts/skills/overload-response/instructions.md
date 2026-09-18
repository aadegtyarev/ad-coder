**This instruction is mandatory.** Where this skill's description matches the work in front of you, the method below is required: an approach that contradicts it is a defect to fix, not a preference to keep.

When the work does not fit, the answer is to split it — not to make more room.

A stage that runs out of room has been given too much work. Raising the ceiling,
summarising harder, or rerunning the same brief with a warmer cache all buy one
more attempt at the same impossible task. Splitting it changes the task. This
applies to every stage — planning drowns in a large input exactly as
implementation does.

## The signals, cheapest first

Each of these is a reason to report "this needs decomposing" rather than to push
on. They are ordered by what it costs to detect them: the first is free and
happens before any work, the last is only visible after a stage has already been
spent.

1. **The plan does not fit the window.** Check the size of the plan against the
   model's context before starting work, not after. A plan past a set fraction
   of the window — a third is a reasonable default — is a plan the stage cannot
   hold alongside the code it must read. This costs one comparison.
2. **The plan is being summarised.** A plan that passes through compaction comes
   back as a paraphrase, and the stage then works from the paraphrase. Exclude
   the plan from what gets compacted and carry it verbatim; if it cannot be
   carried whole, that is signal 1 again, and the answer is the same.
3. **Compaction is firing repeatedly in a short span.** One compaction is
   housekeeping. Several within a few turns means the working set genuinely does
   not fit, and each round loses more of what the stage needs. The burst is the
   signal, not any single occurrence.
4. **Output starvation.** A stage whose output is a tiny fraction of its input
   and which mutated nothing has produced reconnaissance instead of work,
   regardless of whether any ceiling was approached. Measured example: a coder
   stage consuming 270548 input tokens, emitting 1995, and editing zero files —
   its own report said every turn went to reading. Detectable from the
   accounting rows a run already writes, with no cooperation from the model.
5. **The input ceiling is actually exhausted.** The last and most expensive
   signal, because by the time it fires the stage has already spent its budget.
   A run that only ever detects this one is a run that pays full price for every
   diagnosis.

## Raising a ceiling is allowed once, and only once

A single bounded raise — around half again, by default — is a reasonable bet
when the work is genuinely close. What is not reasonable is a second raise. If
one extra allowance did not finish it, the shape of the task is wrong, and more
room will not fix a shape.

The same holds for retries in time or rounds: one more attempt, within sane
limits, then decomposition. "Sane" is deployment-specific, which is why these
are settings and not constants.

## What decomposition actually means here

Not "the first third of the work". Split into pieces that each have their own
acceptance criterion and leave the project working whether or not the next piece
ever happens. Cross-surface work splits by surface, sequentially: a piece
touching three subsystems fails in whichever one is least understood, and the
failure then looks like a defect in the whole.

Prefer the piece that produces evidence. Between two candidates, take the one
whose result teaches you something about the rest.

## Reporting it

A stage that hits one of these signals reports **decompose**, distinctly from
"this needs changes". The difference matters: rerunning an identical brief costs
a full round and arrives at the same wall, while a decompose signal tells
whoever dispatched the work to change the shape of it.

Say which signal fired and what you observed — the measured numbers, not an
impression. Carry forward whatever the spent stage did establish: a map of the
surfaces, the call sites located, the unknowns named. Reconnaissance paid for
once should not be paid for twice.

## What this is not

Not a licence to stop when the work is merely hard. A stage that reports
decompose without a signal is refusing work, and the honest form of that is
saying what is unclear and asking. The signals are specific and measurable
precisely so that "this is too big" is a finding rather than a mood.
