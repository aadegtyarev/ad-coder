# Pipeline change-context contract

This contract owns how the built-in pipeline selects and passes changed-workspace
context to its next role. It is not a general Git-diff API or a custom-workflow
requirement.

## Guarantees

- A change-context strategy starts with the smallest safe representation expected
  to let its consumer decide: changed paths and summary, bounded diff, selected
  files, or declared full context. It records representation, omissions, source,
  measured size, and cost attribution with the pipeline run.
- The default strategy optimizes accepted-result cost, not token count alone. It
  accounts for rereads, retries, repair rounds, rejected review, and time caused
  by insufficient context; smaller input is preferred only while it remains the
  cheaper sufficient choice.
- A consumer may explicitly request more context. A truncation, failed context
  measurement, repeated context-missing result, or evidence that compact context
  increases full-cycle cost widens the next relevant handoff through the declared
  strategy. It never silently claims omitted material was seen.
- Full-context fallback is a visible, attributable selection, not a failure. It
  keeps secret/path redaction in every representation and does not cancel current
  work, switch provider, or block the pipeline solely because a compact handoff
  was insufficient.
- Git-backed workspaces may measure tracked and untracked diffs. Another workspace
  adapter supplies its declared equivalent change source; when none is available,
  the strategy reports that fact and requests or selects another allowed context
  source rather than pretending an empty diff is complete.
- Path count, per-path bytes, aggregate bytes, redaction rules, and measurement
  outcomes remain distinct facts. Escalation uses true measured size where it is
  available, never the size of a truncated projection.

## Configuration

Change-context strategy, initial representation, widening triggers, per-stage
limits, redaction rules, evidence window, and full-context fallback are independent
settings. The default is adaptive economy; an operator or orchestrator can inspect
and select another allowed strategy through the shared settings interface.

## Verification

Test compact handoff, UTF-8-safe truncation, redaction, Git and non-Git source
selection, missing source, explicit widening, repeated context-missing widening,
full-context attribution, true-size escalation, and feedback that changes the
selected strategy only from recorded full-cycle evidence.

## Related surfaces

- [Configuration](config.md) owns setting resolution.
- [Task estimation](task-estimation.md) owns full-cycle cost evidence.
- [Routing calibration](routing-calibration.md) owns durable economic evidence.
- [Quality](quality.md) owns pipeline gates.
- [Errors](errors.md) owns typed failure projection.
