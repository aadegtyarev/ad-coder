import { expect, test } from "bun:test";
import {
  parseTelegramRoomBindings,
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

test("fixed rooms are immutable but can be removed", () => {
  const rooms = new TelegramRoomBindingStore();
  rooms.create("group:7/topic:3", "fixed", session);
  expect(() => rooms.attach("group:7/topic:3", "sessbbbbbbbbbbbbbbb")).toThrow(
    TelegramRoomBindingError,
  );
  expect(rooms.remove("group:7/topic:3").sessionId).toBe(session);
  expect(rooms.resolve("group:7/topic:3")).toBeUndefined();
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
  expect(() => rooms.create("fixed", "fixed", null)).toThrow(TelegramRoomBindingError);
  expect(() => rooms.create("bad\u0000room", "switchable", null)).toThrow(TelegramRoomBindingError);
  expect(() => parseTelegramRoomBindings({ version: 2, bindings: {} })).toThrow(
    TelegramRoomBindingError,
  );
});
