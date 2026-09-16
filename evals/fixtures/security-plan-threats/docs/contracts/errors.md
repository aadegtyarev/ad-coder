# Error and boundary contract

- A report is written atomically: a reader never observes a partial file, and a
  failed write leaves the previous version in place.
- Outbound requests go only to hosts on the configured allow list.
- Errors returned to a client name the failed operation and never include the
  filesystem path, the query, or credential material.
