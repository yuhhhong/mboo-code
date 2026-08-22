import assert from "node:assert/strict";
import test from "node:test";

import { readSessionEventStream, SessionStreamError } from "./session-stream";
import type { SessionEvent } from "./session-types";

test("delivers fragmented SSE events in source order after asynchronous handlers", async () => {
  const events = Array.from({ length: 100 }, (_, index) => createDeltaEvent(index));
  const source = events.map((event) => `event: session\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const chunks = [source.slice(0, 37), source.slice(37, 311), source.slice(311)];
  const delivered: string[] = [];

  await readSessionEventStream(new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  })), async (event) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    delivered.push(event.payload.text);
  });

  assert.deepEqual(delivered, events.map((event) => event.payload.text));
});

test("reports malformed JSON from a session event without hiding the stream error", async () => {
  const response = new Response("event: session\ndata: {invalid-json}\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });

  await assert.rejects(
    readSessionEventStream(response, () => undefined),
    (error: unknown) => error instanceof SessionStreamError && error.message.includes("无法解析后端会话事件"),
  );
});

function createDeltaEvent(index: number): SessionEvent & { payload: { text: string } } {
  return {
    eventId: `event-${index}`,
    sessionId: "session-test",
    turnId: "turn-test",
    type: "ASSISTANT_MESSAGE_DELTA",
    source: "ASSISTANT",
    createdAt: new Date(0).toISOString(),
    payload: { messageId: "message-test", text: `联调长回复-${String(index).padStart(3, "0")}` },
    meta: {},
  };
}
