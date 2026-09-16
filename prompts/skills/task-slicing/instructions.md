Turn a broad request into one slice that can ship on its own and be shown to be correct.

A slice is not "the first third of the work". It is a change with its own acceptance criterion, which leaves the project working whether or not the next slice ever happens. If removing the rest of the plan makes this piece pointless, it is not a slice — it is a stage, and stages have to be sequenced, not shipped.

State six things, briefly:

- **Goal** — what becomes true when this lands, in the operator's terms rather than the code's.
- **In scope** — the surfaces this touches, by path.
- **Out of scope** — the surfaces it deliberately does not, especially the tempting neighbours. This is the half that prevents scope creep, and it is the half usually omitted.
- **Acceptance** — the check that decides it, phrased so it can be run. "Retries work" is not a criterion; "returns 429 after 100 requests in a minute" is. If a criterion cannot be run, it will be argued about instead.
- **Risks** — what this could break that is not obvious from the diff.
- **Stop condition** — what makes you stop and ask rather than continue. Without it, an ambiguous task expands until a budget ends it.

Sizing, from what goes wrong:

- **Cross-surface work splits by surface, sequentially.** A slice touching three subsystems fails in whichever one you understand least, and the failure looks like a defect in the whole.
- **Prefer the slice that produces evidence.** Between two candidates, take the one whose result teaches you something about the rest — a slice that resolves an unknown is worth more than a slice that merely finishes sooner.
- **A slice that cannot be tested is a slice that is not ready.** If nothing can check it, either the acceptance criterion is missing or the change is in the wrong place.

When the request is genuinely ambiguous, do not slice it into a guess. Name the two readings and ask which one is meant. A slice built on the wrong reading costs the whole slice; the question costs one message.
