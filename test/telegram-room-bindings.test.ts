import { expect, test } from "bun:test";
import {
  parseTelegramRoomBindings,
  TelegramRoomBindingError,
  TelegramRoomBindingStore,
} from "../src";

const session = "sessabcdefabcdefabc";

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
