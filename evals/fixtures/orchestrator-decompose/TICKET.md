# Ticket NS-114: SMS delivery

The notification service sends email only. Operations wants SMS, and wants it
observable and safe to run under load.

- **R1.** Add an SMS channel to `sendNotification`, alongside the existing email
  path.
- **R2.** Record the SMS provider's delivery id in the service log, the way the
  email path's id is returned to the caller today.
- **R3.** Reject an empty recipient before any provider call is made, so a
  malformed request never becomes a billable one.
- **R4.** Rate-limit outbound sends to 100 per minute and reject anything over
  the limit with a 429-style error.
- **R5.** Accept the SMS provider's delivery-status webhook and record the status
  it reports against the original send.
- **R6.** Retry a failed SMS send with exponential backoff, up to three attempts.
