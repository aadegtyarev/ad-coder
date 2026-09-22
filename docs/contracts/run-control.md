# Run control contract

This contract owns explicit stopping of a recorded run.

## Guarantees

- `ad-coder runs stop <run-id> --target-dir <dir>` acts only on the process
  identity in that run's own durable record. It never uses machine-wide command
  matching or guesses from a similar path.
- Before a signal, the record is readable and names a live non-zombie pid with
  matching process start time, exact target-dir argument, and run witness tokens.
  A prefix path, corrupt record, missing identity, reused pid, or unsafe group is
  a refusal with no signal sent.
- `--group` requires proof that the run leads its process group. `--kill` sends
  SIGTERM, waits the configured bounded period (default 2000 ms), then SIGKILL.
  The stop-request witness is written before the first signal.
- Exit 0 means a verified signal was delivered; 1 means the verified pid was
  already dead; 2 is usage; 3 is refusal. JSON returns the stable structured
  result or error and names checked candidates for a missing record.

## Verification

Test valid standalone and background records, dead and reused pids, corrupt or
missing records, path-prefix mismatch, group refusal, escalation, and witness
write ordering.

## Related surfaces

- [Session manager](session-manager.md) owns durable run records.
- [Security](security.md) owns authority boundaries.
- [CLI](cli.md) owns general command rendering.
