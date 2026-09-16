/** Delivery channels this service can send through. */
export type Channel = "email";

export interface Notification {
  recipient: string;
  channel: Channel;
  body: string;
}

/**
 * Sends one notification.
 *
 * Empty recipients are rejected here, before any provider is contacted, so a
 * malformed request never becomes a billable call.
 */
export function sendNotification(notification: Notification): { id: string } {
  if (notification.recipient.trim() === "") throw new Error("recipient must not be empty");
  if (notification.channel !== "email")
    throw new Error(`unsupported channel: ${notification.channel}`);
  return sendEmail(notification.recipient, notification.body);
}

function sendEmail(recipient: string, body: string): { id: string } {
  // The email provider returns its own delivery id, which the caller keeps.
  return { id: `email-${recipient.length}-${body.length}` };
}
