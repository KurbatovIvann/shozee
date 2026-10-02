import type { protos } from "@google-cloud/speech";
import { VOICE_SAMPLE_RATE_HZ } from "@showzy/validation/assistant-voice";

export const VOICE_LANGUAGE_CODES: readonly string[] = ["uk-UA", "ru-RU"];

export interface VoiceRecognitionEvents {
  partial(text: string): void;
  final(text: string): void;
  failed(code: string): void;
}

export interface VoiceRecognitionStream {
  write(pcm: Buffer): boolean;
  finish(): void;
  abort(): void;
}

export interface VoiceRecognizer {
  start(events: VoiceRecognitionEvents): VoiceRecognitionStream;
  close(): Promise<void>;
}

type StreamingRequest =
  protos.google.cloud.speech.v2.IStreamingRecognizeRequest;
type StreamingResponse =
  protos.google.cloud.speech.v2.IStreamingRecognizeResponse;

export interface ChirpCall {
  write(request: StreamingRequest): boolean;
  end(): void;
  cancel(): void;
  onResponse(listener: (response: StreamingResponse) => void): void;
  onError(listener: (error: unknown) => void): void;
  onEnd(listener: () => void): void;
}

export interface ChirpClient {
  streamingRecognize(): ChirpCall;
  close(): Promise<void>;
}

export interface ChirpVoiceOptions {
  readonly client: ChirpClient;
  readonly projectId: string;
  readonly location: string;
}

const GRPC_CODES: Readonly<Record<number, string>> = {
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  16: "UNAUTHENTICATED",
};

export function googleErrorCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  if (typeof code === "number") {
    return GRPC_CODES[code] ?? `GRPC_${String(code)}`;
  }
  return "UNKNOWN";
}

export class ChirpVoiceRecognizer implements VoiceRecognizer {
  readonly #client: ChirpClient;
  readonly #recognizerName: string;

  constructor(options: ChirpVoiceOptions) {
    this.#client = options.client;
    this.#recognizerName = `projects/${options.projectId}/locations/${options.location}/recognizers/_`;
  }

  streamingConfig(): StreamingRequest {
    return {
      recognizer: this.#recognizerName,
      streamingConfig: {
        config: {
          model: "chirp_3",
          languageCodes: [...VOICE_LANGUAGE_CODES],
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: VOICE_SAMPLE_RATE_HZ,
            audioChannelCount: 1,
          },
        },
        streamingFeatures: { interimResults: true },
      },
    };
  }

  start(events: VoiceRecognitionEvents): VoiceRecognitionStream {
    const call = this.#client.streamingRecognize();
    let finals = "";
    let latest = "";
    let open = true;
    let settled = false;

    const settle = (outcome: () => void): void => {
      open = false;
      if (settled) {
        return;
      }
      settled = true;
      outcome();
    };

    call.onResponse((response) => {
      if (settled) {
        return;
      }
      const results = response.results ?? [];
      if (results.length === 0) {
        return;
      }
      let guess = "";
      for (const result of results) {
        const text = result.alternatives?.[0]?.transcript?.trim() ?? "";
        if (result.isFinal === true) {
          finals = joinTranscript(finals, text);
        } else {
          guess = joinTranscript(guess, text);
        }
      }
      latest = joinTranscript(finals, guess);
      events.partial(latest);
    });
    call.onError((error) => {
      settle(() => {
        events.failed(googleErrorCode(error));
      });
    });
    call.onEnd(() => {
      settle(() => {
        events.final(latest === "" ? finals : latest);
      });
    });
    call.write(this.streamingConfig());

    return {
      write(pcm) {
        if (!open) {
          return false;
        }
        return call.write({ audio: pcm });
      },
      finish() {
        if (!open) {
          return;
        }
        open = false;
        call.end();
      },
      abort() {
        settled = true;
        open = false;
        call.cancel();
      },
    };
  }

  close(): Promise<void> {
    return this.#client.close();
  }
}

export interface ChirpVoiceSetup {
  readonly credentialsFile: string;
  readonly projectId: string | undefined;
  readonly location: string;
}

export async function createChirpVoiceRecognizer(
  setup: ChirpVoiceSetup,
): Promise<VoiceRecognizer> {
  const { v2 } = await import("@google-cloud/speech");
  const client = new v2.SpeechClient({
    apiEndpoint: `${setup.location}-speech.googleapis.com`,
    keyFilename: setup.credentialsFile,
  });
  const projectId = setup.projectId ?? (await client.getProjectId());
  return new ChirpVoiceRecognizer({
    projectId,
    location: setup.location,
    client: {
      streamingRecognize() {
        const stream = client._streamingRecognize();
        return {
          write: (request) => stream.write(request),
          end: () => {
            stream.end();
          },
          cancel: () => {
            stream.cancel();
          },
          onResponse: (listener) => {
            stream.on("data", listener);
          },
          onError: (listener) => {
            stream.on("error", listener);
          },
          onEnd: (listener) => {
            stream.on("end", listener);
          },
        };
      },
      close: () => client.close(),
    },
  });
}

function joinTranscript(left: string, right: string): string {
  if (left === "") {
    return right;
  }
  if (right === "") {
    return left;
  }
  return `${left} ${right}`;
}
