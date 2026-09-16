import {
  parseAssistantStreamEvent,
  type AssistantStreamEvent,
} from "@showzy/validation/assistant-events";

export interface Frame {
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
}

export interface EventReader {
  next(): Promise<Frame | null>;
  cancel(): Promise<void>;
}

export function eventReader(response: Response): EventReader {
  if (response.body === null) {
    throw new Error("an event stream has a body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return parseFrame(block);
        }
        const chunk = await reader.read();
        if (chunk.done) {
          return null;
        }
        buffer += decoder.decode(chunk.value as Uint8Array, { stream: true });
      }
    },
    async cancel() {
      await reader.cancel();
    },
  };
}

function parseFrame(block: string): Frame {
  let event: string | undefined;
  const data: string[] = [];
  let comment: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      comment = line.slice(1).trim();
    } else if (line.startsWith("event: ")) {
      event = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      data.push(line.slice("data: ".length));
    }
  }
  return {
    ...(event === undefined ? {} : { event }),
    ...(data.length === 0 ? {} : { data: data.join("\n") }),
    ...(comment === undefined ? {} : { comment }),
  };
}

export async function nextEvent(
  reader: EventReader,
): Promise<AssistantStreamEvent> {
  const frame = await reader.next();
  if (frame?.event === undefined || frame.data === undefined) {
    throw new Error(`expected an event, got ${JSON.stringify(frame)}`);
  }
  const event = parseAssistantStreamEvent(frame.event, frame.data);
  if (event === null) {
    throw new Error(`unreadable ${frame.event} event: ${frame.data}`);
  }
  return event;
}
