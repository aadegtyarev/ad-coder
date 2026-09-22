# Refactoring practice research

For maintainers deciding how to separate code without changing its behaviour.
This note answers which safeguards are sufficiently general to become the
[decomposition contract](contracts/decomposition.md).

## Findings

- Refactoring is a sequence of small behaviour-preserving structural changes,
  not a synonym for a feature change or redesign. Keep those modes explicit.
- A green, behaviour-oriented test baseline makes small steps useful. Test the
  public outcome rather than the implementation shape, or restructuring turns
  tests into a source of false failures.
- If an external dependency makes an observation non-deterministic, establish a
  narrow seam and substitute a deterministic test double before changing the
  surrounding structure.
- A published interface is observable behaviour. Renaming it is safe only when
  all callers under responsibility are moved too; otherwise it is a product and
  compatibility decision.
- Compiler- or language-service-assisted moves reduce risk but do not replace
  behavioural checks, especially across dynamic calls and external boundaries.

## Sources checked

- [Martin Fowler: Refactoring](https://martinfowler.com/books/refactoring.html)
  — definition and small behaviour-preserving transformations.
- [Martin Fowler: Refactoring external services](https://martinfowler.com/articles/refactoring-external-service.html)
  — deterministic seams and test doubles.
- [Martin Fowler: Changing interfaces](https://martinfowler.com/bliki/IsChangingInterfacesRefactoring.html)
  — caller ownership and published-interface risk.
- [Microsoft: execute cloud modernizations](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/modernize/execute-cloud-modernization)
  — incremental source-controlled work and regression, integration, and
  end-to-end validation.
