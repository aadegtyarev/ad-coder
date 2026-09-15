# Error and boundary contract

- A request identifier is validated before it reaches the filesystem, and no
  request may produce a path outside the configured report directory.
- Outbound requests go only to hosts on the configured allow list.
- Errors returned to a client name the failed operation and never include the
  filesystem path, the query, or credential material.
