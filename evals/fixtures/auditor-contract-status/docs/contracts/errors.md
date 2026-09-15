# Error contract

- Every rejected input fails with `Error("invalid <field>")` and no other
  wording, so a caller can branch on the message.
- A failure that originates below this layer is rethrown with its original
  error attached as `cause`; it is never replaced by a fresh error.
