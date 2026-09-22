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

export type TelegramRoomBindingErrorCode =
  | "invalid_binding"
  | "already_bound"
  | "not_bound"
  | "unsupported_kind";

const TELEGRAM_ROOM_BINDING_ERROR_DETAILS: Record<
  TelegramRoomBindingErrorCode,
  { readonly message: string; readonly nextAction: string }
> = {
  invalid_binding: {
    message: "the Telegram room binding is invalid",
    nextAction: "correct the Telegram room binding data, then retry",
  },
  already_bound: {
    message: "the Telegram room is already bound",
    nextAction: "use the existing binding or remove it before creating another",
  },
  not_bound: {
    message: "the Telegram room has no binding",
    nextAction: "create the Telegram room binding before attaching or removing it",
  },
  unsupported_kind: {
    message: "Telegram v1 supports only switchable room bindings",
    nextAction: "use a switchable room binding; fixed is reserved for a later Telegram mode",
  },
};

/** A safe, machine-readable projection of an expected binding failure. */
export interface TelegramRoomBindingErrorProjection {
  readonly code: TelegramRoomBindingErrorCode;
  readonly message: string;
  readonly retryable: false;
  readonly nextAction: string;
}

export class TelegramRoomBindingError extends Error implements TelegramRoomBindingErrorProjection {
  override readonly name = "TelegramRoomBindingError";
  readonly retryable = false as const;
  override readonly message: string;
  readonly nextAction: string;

  constructor(readonly code: TelegramRoomBindingErrorCode) {
    const details = TELEGRAM_ROOM_BINDING_ERROR_DETAILS[code];
    super(details.message);
    this.message = details.message;
    this.nextAction = details.nextAction;
  }

  /** Return only the stable fields allowed across a public error boundary. */
  toProjection(): TelegramRoomBindingErrorProjection {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      nextAction: this.nextAction,
    };
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

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
  if (Object.keys(value).some((key) => key !== "version" && key !== "bindings"))
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
  return parseTelegramRoomBindings(document);
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
    if (kind === "fixed") throw new TelegramRoomBindingError("unsupported_kind");
    if (this.bindings.has(roomId)) throw new TelegramRoomBindingError("already_bound");
    const record = assertRecord({ kind, sessionId });
    this.bindings.set(roomId, record);
    return copy({ roomId, ...record });
  }

  attach(roomId: string, sessionId: string): TelegramRoomBinding {
    assertRoomId(roomId);
    const current = this.bindings.get(roomId);
    if (current === undefined) throw new TelegramRoomBindingError("not_bound");
    if (current.kind === "fixed") throw new TelegramRoomBindingError("unsupported_kind");
    const next = { kind: current.kind, sessionId: assertSessionId(sessionId, false) } as const;
    this.bindings.set(roomId, next);
    return copy({ roomId, ...next });
  }

  remove(roomId: string): TelegramRoomBinding {
    assertRoomId(roomId);
    const current = this.bindings.get(roomId);
    if (current === undefined) throw new TelegramRoomBindingError("not_bound");
    if (current.kind === "fixed") throw new TelegramRoomBindingError("unsupported_kind");
    this.bindings.delete(roomId);
    return copy({ roomId, ...current });
  }

  resolve(roomId: string): TelegramRoomBinding | undefined {
    assertRoomId(roomId);
    const record = this.bindings.get(roomId);
    return record === undefined || record.kind === "fixed"
      ? undefined
      : copy({ roomId, ...record });
  }

  list(): TelegramRoomBinding[] {
    return [...this.bindings.entries()]
      .filter(([, record]) => record.kind === "switchable")
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
