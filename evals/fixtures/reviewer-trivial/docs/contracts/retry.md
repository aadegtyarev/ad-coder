# Retry contract

- A caller-supplied retry count is honoured exactly, including zero, which means
  "do not retry".
- `maxRetries` is optional; when the caller omits it the default applies.
