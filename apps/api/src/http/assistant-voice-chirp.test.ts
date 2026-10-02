import type { protos } from "@google-cloud/speech";
import { describe, expect, it } from "vitest";

import {
  ChirpVoiceRecognizer,
  googleErrorCode,
  type ChirpCall,
  type ChirpClient,
} from "./assistant-voice-chirp.js";
import type { VoiceRecognitionEvents } from "./assistant-voice-recognizer.js";

type StreamingRequest =
  protos.google.cloud.speech.v2.IStreamingRecognizeRequest;
type StreamingResponse =
  protos.google.cloud.speech.v2.IStreamingRecognizeResponse;

interface FakeCall extends ChirpCall {
  readonly requests: StreamingRequest[];
  readonly state: { ended: boolean; cancelled: boolean };
  respond(response: StreamingResponse): void;
  fail(error: unknown): void;
  finish(): void;
}

function fakeClient(): { client: ChirpClient; call: FakeCall } {
  const requests: StreamingRequest[] = [];
  const state = { ended: false, cancelled: false };
  const listeners: {
    response: ((response: StreamingResponse) => void)[];
    error: ((error: unknown) => void)[];
    end: (() => void)[];
  } = { response: [], error: [], end: [] };
  const call: FakeCall = {
    requests,
    state,
    write: (request) => {
      requests.push(request);
    },
    end: () => {
      state.ended = true;
    },
    cancel: () => {
      state.cancelled = true;
    },
    onResponse: (listener) => listeners.response.push(listener),
    onError: (listener) => listeners.error.push(listener),
    onEnd: (listener) => listeners.end.push(listener),
    respond: (response) => {
      for (const listener of listeners.response) listener(response);
    },
    fail: (error) => {
      for (const listener of listeners.error) listener(error);
    },
    finish: () => {
      for (const listener of listeners.end) listener();
    },
  };
  return {
    call,
    client: {
      streamingRecognize: () => call,
      close: () => Promise.resolve(),
    },
  };
}

function recorder(): {
  readonly events: VoiceRecognitionEvents;
  readonly partials: string[];
  readonly finals: string[];
  readonly failures: string[];
} {
  const partials: string[] = [];
  const finals: string[] = [];
  const failures: string[] = [];
  return {
    partials,
    finals,
    failures,
    events: {
      partial: (text) => partials.push(text),
      final: (text) => finals.push(text),
      failed: (code) => failures.push(code),
    },
  };
}

function interim(transcript: string, isFinal: boolean): StreamingResponse {
  return { results: [{ alternatives: [{ transcript }], isFinal }] };
}

function chirp(): ReturnType<typeof fakeClient> & {
  readonly recognizer: ChirpVoiceRecognizer;
} {
  const fake = fakeClient();
  return {
    ...fake,
    recognizer: new ChirpVoiceRecognizer({
      client: fake.client,
      projectId: "showzy-voice",
      location: "eu",
    }),
  };
}

describe("chirp voice recognizer", () => {
  it("opens the stream with Chirp 3, both languages and 16 kHz LINEAR16", () => {
    const { recognizer, call } = chirp();

    recognizer.start(recorder().events);

    expect(call.requests[0]).toEqual({
      recognizer: "projects/showzy-voice/locations/eu/recognizers/_",
      streamingConfig: {
        config: {
          model: "chirp_3",
          languageCodes: ["uk-UA", "ru-RU"],
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: 16_000,
            audioChannelCount: 1,
          },
        },
        streamingFeatures: { interimResults: true },
      },
    });
  });

  it("reports every guess as a partial and settles the final on half-close", () => {
    const { recognizer, call } = chirp();
    const sink = recorder();

    const stream = recognizer.start(sink.events);
    stream.write(Buffer.from([1, 2, 3, 4]));
    call.respond(interim("дві пачки", false));
    call.respond(interim("дві пачки кави", true));
    stream.finish();
    call.finish();

    expect(call.requests[1]).toEqual({ audio: Buffer.from([1, 2, 3, 4]) });
    expect(call.state.ended).toBe(true);
    expect(sink.partials).toEqual(["дві пачки", "дві пачки кави"]);
    expect(sink.finals).toEqual(["дві пачки кави"]);
    expect(sink.failures).toEqual([]);
  });

  it("keeps a trailing guess that never became final", () => {
    const { recognizer, call } = chirp();
    const sink = recorder();

    recognizer.start(sink.events);
    call.respond(interim("дві пачки", true));
    call.respond(interim("кави", false));
    call.finish();

    expect(sink.finals).toEqual(["дві пачки кави"]);
  });

  it("reports the gRPC status name and never a final after a failure", () => {
    const { recognizer, call } = chirp();
    const sink = recorder();

    recognizer.start(sink.events);
    call.fail({ code: 14, message: "backend unavailable" });
    call.finish();

    expect(sink.failures).toEqual(["UNAVAILABLE"]);
    expect(sink.finals).toEqual([]);
  });

  it("drops the call on abort and answers nothing", () => {
    const { recognizer, call } = chirp();
    const sink = recorder();

    const stream = recognizer.start(sink.events);
    stream.abort();
    stream.write(Buffer.from([1, 2]));
    call.finish();

    expect(call.state.cancelled).toBe(true);
    expect(call.requests).toHaveLength(1);
    expect(sink.finals).toEqual([]);
    expect(sink.failures).toEqual([]);
  });

  it("names an unrecognised error shape without leaking it", () => {
    expect(googleErrorCode(new Error("key file unreadable"))).toBe("UNKNOWN");
    expect(googleErrorCode({ code: 7 })).toBe("PERMISSION_DENIED");
    expect(googleErrorCode({ code: 99 })).toBe("GRPC_99");
  });
});
