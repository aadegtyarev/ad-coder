# Meta-contract

A contract specifies the required behaviour of one product surface. A reader
who does not know the project's history must be able to understand that
surface's boundary, guarantees, and failures, then verify a change to it.

Breaking any rule in this document blocks a change to a contract or to code it
governs.

## Boundary and ownership

- A surface is a part of the product that can be read, changed, and verified
  independently: settings, the CLI, errors, or the Telegram front, for example.
- One contract owns one complete surface. A surface may have several topics;
  having two topics is not by itself a reason to split the document.
- Split a topic into its own contract when it has an independent consumer, set
  of invariants, configuration, failures, or verification.
- Every normative rule has one owner: one contract. Repeating a rule, or a
  variant of it, in another contract is forbidden.
- When a boundary is disputed, the contract that defines the behaviour owns it.
  Other documents link to that owner only.

## Content

A contract describes current required behaviour only:

- normal results, boundaries, and failures;
- inputs, outputs, and preserved invariants where the surface has them;
- available configuration and observable verification where they apply.

Every rule needs observable evidence: a test, check, safe output, or another
way to establish that it holds. An unverifiable wish is not a contract rule.

A contract is not an implementation description. Code that differs from the
contract is defective; the contract is not rewritten to match it.

## Links between surfaces

- A link to another contract names only the surface and its owner: “Settings:
  `config.md`.”
- The linking contract does not restate, narrow, or override the owner's rule.
  A reader opens the named contract to apply that rule.
- An operation may link to several surfaces, but its normative parts stay with
  their owners. A new document does not become their copy.

## Form and size

A contract starts with one sentence defining its boundary. It then includes
only the applicable sections from this set:

- `Guarantees`;
- `Failures`;
- `Configuration`;
- `Verification`;
- `Related surfaces`.

One list item expresses one rule. A paragraph does not combine independent
norms or replace a list with long narrative. Write short lines and prose that
can be read in one sitting.

A normal contract is at most 120 lines. Before changing a document that nears
160 lines, reconsider its independent surfaces; an exception needs an explicit
review justification.

`docs/contracts/README.md` is a navigational index: one line per contract with
its surface and the condition for reading it. The index contains no normative
rules.

## No history

Contracts contain no dates, issue numbers, release notes, migrations, former
behaviour, disputes, or decision chronology. Those belong in Git, the
CHANGELOG, and the ROADMAP.

A short rationale is allowed only when it directly constrains a choice that is
available now. When a rule changes, replace it with its current wording; its
previous version remains in Git history.
