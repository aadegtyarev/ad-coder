import { expect, test } from "bun:test";
import {
  parseTelegramRoomBindings,
  serializeTelegramRoomBindings,
  TelegramRoomBindingError,
  TelegramRoomBindingStore,
} from "../src";

const session = "sessabcdefabcdefabc";

test("expected binding failures expose a safe typed actionable projection", () => {
  const cases = [
    ["invalid_binding", "correct the Telegram room binding data, then retry"],
    ["already_bound", "use the existing binding or remove it before creating another"],
    ["not_bound", "create the Telegram room binding before attaching or removing it"],
    ["immutable", "remove the fixed binding before creating a replacement"],
    [
      "unsupported_kind",
      "use a switchable room binding; fixed rooms are reserved for a later Telegram mode",
    ],
  ] as const;

  for (const [code, nextAction] of cases) {
    const error = new TelegramRoomBindingError(code);
    expect(error.toProjection()).toEqual({
      code,
      message: error.message,
      retryable: false,
      nextAction,
    });
    expect(error.message).not.toContain("targetDir");
    expect(error.message).not.toContain("session");
  }
});

test("switchable rooms start unselected and can be attached", () => {
  const rooms = new TelegramRoomBindingStore();
  expect(rooms.create("personal:42", "switchable", null)).toEqual({
    roomId: "personal:42",
    kind: "switchable",
    sessionId: null,
  });
  expect(rooms.attach("personal:42", session).sessionId).toBe(session);
  expect(rooms.resolve("personal:42")?.sessionId).toBe(session);
});

test("fixed rooms remain schema-compatible but v1 operational methods refuse them", () => {
  const fixed = {
    version: 1 as const,
    bindings: { "group:7/topic:3": { kind: "fixed" as const, sessionId: session } },
  };
  expect(parseTelegramRoomBindings(fixed)).toEqual(fixed);

  const rooms = new TelegramRoomBindingStore(fixed);
  expect(rooms.resolve("group:7/topic:3")).toEqual({
    roomId: "group:7/topic:3",
    kind: "fixed",
    sessionId: session,
  });
  expect(() => rooms.attach("group:7/topic:3", "sessbbbbbbbbbbbbbbb")).toThrow(
    new TelegramRoomBindingError("unsupported_kind"),
  );
  expect(() => rooms.remove("group:7/topic:3")).toThrow(
    new TelegramRoomBindingError("unsupported_kind"),
  );
  expect(() => rooms.create("group:8/topic:4", "fixed", session)).toThrow(
    new TelegramRoomBindingError("unsupported_kind"),
  );
  expect(rooms.resolve("group:7/topic:3")?.kind).toBe("fixed");
});

test("the schema is strict, versioned, and never emits targetDir", () => {
  const rooms = new TelegramRoomBindingStore();
  rooms.create("personal:42", "switchable", null);
  const document = rooms.toDocument();
  expect(JSON.stringify(document)).not.toContain("targetDir");
  expect(parseTelegramRoomBindings(document)).toEqual(document);
  expect(() =>
    parseTelegramRoomBindings({
      version: 1,
      bindings: { room: { kind: "switchable", sessionId: null, targetDir: "/secret" } },
    }),
  ).toThrow(TelegramRoomBindingError);
});

test("fixed bindings require a selected session and malformed ids fail closed", () => {
  const rooms = new TelegramRoomBindingStore();
  expect(() => rooms.create("fixed", "fixed", null)).toThrow(
    new TelegramRoomBindingError("unsupported_kind"),
  );
  expect(() => rooms.create("bad\u0000room", "switchable", null)).toThrow(TelegramRoomBindingError);
  expect(() => parseTelegramRoomBindings({ version: 2, bindings: {} })).toThrow(
    TelegramRoomBindingError,
  );
});

test("parser rejects every unknown root key, including paths and credentials", () => {
  const invalidRootKeys = ["targetDir", "botToken", "apiKey", "accessToken"];

  for (const key of invalidRootKeys) {
    expect(() =>
      parseTelegramRoomBindings({ version: 1, bindings: {}, [key]: "secret-value" }),
    ).toThrow(TelegramRoomBindingError);
  }
});

test("parser and serializer reject non-plain JSON records", () => {
  const valid = { version: 1, bindings: {} };
  const decorated = (value: object): unknown => Object.assign(value, valid);
  const invalidRoots = [
    decorated(new Map()),
    decorated(new Date()),
    decorated(new Number(1)),
    decorated(new String("bindings")),
    decorated(new Boolean(true)),
    Object.assign(Object.create({ custom: true }), valid),
  ];

  for (const value of invalidRoots) {
    expect(() => parseTelegramRoomBindings(value)).toThrow(TelegramRoomBindingError);
    expect(() =>
      serializeTelegramRoomBindings(value as Parameters<typeof serializeTelegramRoomBindings>[0]),
    ).toThrow(TelegramRoomBindingError);
  }

  const customBindings = Object.assign(Object.create({ custom: true }), {});
  customBindings.room = { kind: "switchable", sessionId: null };
  expect(() => parseTelegramRoomBindings({ version: 1, bindings: customBindings })).toThrow(
    TelegramRoomBindingError,
  );

  const customRecord = Object.assign(Object.create({ custom: true }), {
    kind: "switchable",
    sessionId: null,
  });
  expect(() => parseTelegramRoomBindings({ version: 1, bindings: { room: customRecord } })).toThrow(
    TelegramRoomBindingError,
  );
});
