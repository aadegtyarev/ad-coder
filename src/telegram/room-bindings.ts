/**
 * Secret-free Telegram room bindings. This module stores only the room key,
 * binding kind, and shared SessionManager session id. Project paths and
 * credentials are deliberately not part of this schema.
 */

export const TELEGRAM_ROOM_BINDINGS_VERSION = 1 as const;
export const TELEGRAM_SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{8,63}$/;

export type TelegramRoomBindingKind = "switchable" | "fixed";

export interface TelegramRoomBinding {
  readonly roomId: string;
  readonly kind: TelegramRoomBindingKind;
  readonly sessionId: string | null;
}

/** The durable wire shape. It contains no targetDir or other project data. */
export interface TelegramRoomBindingsDocument {
  readonly version: typeof TELEGRAM_ROOM_BINDINGS_VERSION;
  readonly bindings: Readonly<Record<string, TelegramRoomBindingRecord>>;
}

export interface TelegramRoomBindingRecord {
  readonly kind: TelegramRoomBindingKind;
  readonly sessionId: string | null;
}

export class TelegramRoomBindingError extends Error {
  override readonly name = "TelegramRoomBindingError";
  constructor(readonly code: "invalid_binding" | "already_bound" | "not_bound" | "immutable") {
    super(telegramRoomBindingErrorMessage(code));
  }
}

function telegramRoomBindingErrorMessage(code: TelegramRoomBindingError["code"]): string {
  switch (code) {
    case "invalid_binding":
      return "the Telegram room binding is invalid";
    case "already_bound":
      return "the Telegram room is already bound";
    case "not_bound":
      return "the Telegram room has no binding";
    case "immutable":
      return "a fixed Telegram room binding cannot be changed";
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function assertRoomId(roomId: string): string {
  if (
    typeof roomId !== "string" ||
    roomId.length === 0 ||
    roomId.length > 256 ||
    [...roomId].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  )
    throw new TelegramRoomBindingError("invalid_binding");
  return roomId;
}

function assertSessionId(sessionId: string | null, allowNull: boolean): string | null {
  if (sessionId === null && allowNull) return null;
  if (typeof sessionId !== "string" || !TELEGRAM_SESSION_ID_PATTERN.test(sessionId))
    throw new TelegramRoomBindingError("invalid_binding");
  return sessionId;
}

function assertRecord(value: unknown): TelegramRoomBindingRecord {
  if (!isPlainRecord(value)) throw new TelegramRoomBindingError("invalid_binding");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "kind" && key !== "sessionId"))
    throw new TelegramRoomBindingError("invalid_binding");
  const kind = value.kind;
  if (kind !== "switchable" && kind !== "fixed")
    throw new TelegramRoomBindingError("invalid_binding");
  const sessionId = assertSessionId(value.sessionId as string | null, kind === "switchable");
  return { kind, sessionId };
}

/** Parse and strictly validate persisted room bindings. */
export function parseTelegramRoomBindings(value: unknown): TelegramRoomBindingsDocument {
  if (!isPlainRecord(value) || value.version !== TELEGRAM_ROOM_BINDINGS_VERSION)
    throw new TelegramRoomBindingError("invalid_binding");
  if (!isPlainRecord(value.bindings)) throw new TelegramRoomBindingError("invalid_binding");
  const bindings: Record<string, TelegramRoomBindingRecord> = Object.create(null) as Record<
    string,
    TelegramRoomBindingRecord
  >;
  for (const [roomId, record] of Object.entries(value.bindings)) {
    assertRoomId(roomId);
    bindings[roomId] = assertRecord(record);
  }
  return { version: TELEGRAM_ROOM_BINDINGS_VERSION, bindings };
}

export function serializeTelegramRoomBindings(
  document: TelegramRoomBindingsDocument,
): TelegramRoomBindingsDocument {
  return parseTelegramRoomBindings(JSON.parse(JSON.stringify(document)));
}

const copy = (binding: TelegramRoomBinding): TelegramRoomBinding => ({ ...binding });

/** In-memory API; persistence belongs to the owner-private front state store. */
export class TelegramRoomBindingStore {
  private readonly bindings = new Map<string, TelegramRoomBindingRecord>();

  constructor(document?: TelegramRoomBindingsDocument) {
    if (document !== undefined) {
      const parsed = parseTelegramRoomBindings(document);
      for (const [roomId, record] of Object.entries(parsed.bindings))
        this.bindings.set(roomId, { ...record });
    }
  }

  create(
    roomId: string,
    kind: TelegramRoomBindingKind,
    sessionId: string | null,
  ): TelegramRoomBinding {
    assertRoomId(roomId);
    if (this.bindings.has(roomId)) throw new TelegramRoomBindingError("already_bound");
    const record = assertRecord({ kind, sessionId });
    this.bindings.set(roomId, record);
    return copy({ roomId, ...record });
  }

  attach(roomId: string, sessionId: string): TelegramRoomBinding {
    assertRoomId(roomId);
    const current = this.bindings.get(roomId);
    if (current === undefined) throw new TelegramRoomBindingError("not_bound");
    if (current.kind === "fixed") throw new TelegramRoomBindingError("immutable");
    const next = { kind: current.kind, sessionId: assertSessionId(sessionId, false) } as const;
    this.bindings.set(roomId, next);
    return copy({ roomId, ...next });
  }

  remove(roomId: string): TelegramRoomBinding {
    assertRoomId(roomId);
    const current = this.bindings.get(roomId);
    if (current === undefined) throw new TelegramRoomBindingError("not_bound");
    this.bindings.delete(roomId);
    return copy({ roomId, ...current });
  }

  resolve(roomId: string): TelegramRoomBinding | undefined {
    assertRoomId(roomId);
    const record = this.bindings.get(roomId);
    return record === undefined ? undefined : copy({ roomId, ...record });
  }

  list(): TelegramRoomBinding[] {
    return [...this.bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([roomId, record]) => copy({ roomId, ...record }));
  }

  toDocument(): TelegramRoomBindingsDocument {
    const bindings: Record<string, TelegramRoomBindingRecord> = Object.create(null) as Record<
      string,
      TelegramRoomBindingRecord
    >;
    for (const [roomId, record] of this.bindings) bindings[roomId] = { ...record };
    return { version: TELEGRAM_ROOM_BINDINGS_VERSION, bindings };
  }
}
