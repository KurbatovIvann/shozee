import { describe, expect, it } from "vitest";

import {
  initialVoiceCaptureState,
  voiceCaptureActive,
  voiceCaptureReducer,
  type VoiceCaptureEvent,
  type VoiceCaptureState,
} from "./voice-capture-state";

function run(
  events: readonly VoiceCaptureEvent[],
  from: VoiceCaptureState = initialVoiceCaptureState,
): VoiceCaptureState {
  return events.reduce(voiceCaptureReducer, from);
}

const GRANTED: readonly VoiceCaptureEvent[] = [
  { type: "requested" },
  { type: "permissionGranted" },
  { type: "ready", sessionMs: 9_000 },
];

describe("voiceCaptureReducer", () => {
  it("walks idle to listening once permission and the socket are in", () => {
    expect(run([{ type: "requested" }]).status).toBe("requesting");
    expect(run(GRANTED.slice(0, 2)).status).toBe("starting");
    expect(run(GRANTED).status).toBe("listening");
  });

  it("makes a refused microphone an explicit state, not a silent idle", () => {
    const state = run([{ type: "requested" }, { type: "permissionDenied" }]);

    expect(state.status).toBe("denied");
    expect(voiceCaptureActive(state.status)).toBe(false);
  });

  it("lets a denied capture be tried again", () => {
    const denied = run([{ type: "requested" }, { type: "permissionDenied" }]);

    expect(run([{ type: "requested" }], denied).status).toBe("requesting");
  });

  it("shows partial text while recognizing", () => {
    const state = run([...GRANTED, { type: "partial", text: "дві" }]);

    expect(state).toMatchObject({ status: "recognizing", partial: "дві" });
  });

  it("ends on the final transcript and keeps how it ended", () => {
    const state = run([
      ...GRANTED,
      { type: "partial", text: "дві" },
      { type: "final", text: "дві пачки", endedBy: "limit" },
    ]);

    expect(state).toEqual({
      status: "idle",
      partial: "",
      transcript: "дві пачки",
      endedBy: "limit",
      failure: null,
      sessionMs: 15_000,
    });
  });

  it("reports a failure with its cause and drops the partial", () => {
    const state = run([
      ...GRANTED,
      { type: "partial", text: "дві" },
      { type: "failed", failure: "busy" },
    ]);

    expect(state).toMatchObject({
      status: "error",
      partial: "",
      transcript: null,
      failure: "busy",
    });
  });

  it("ignores a second tap while a capture is already running", () => {
    const listening = run(GRANTED);

    expect(run([{ type: "requested" }], listening)).toBe(listening);
  });

  it("ignores events that arrive after the capture ended", () => {
    const finished = run([
      ...GRANTED,
      { type: "final", text: "дві пачки", endedBy: "client" },
    ]);

    expect(run([{ type: "failed", failure: "network" }], finished)).toBe(
      finished,
    );
    expect(run([{ type: "partial", text: "ще" }], finished)).toBe(finished);
  });

  it("clears the transcript on reset", () => {
    const finished = run([
      ...GRANTED,
      { type: "final", text: "дві пачки", endedBy: "client" },
    ]);

    expect(run([{ type: "reset" }], finished)).toEqual(
      initialVoiceCaptureState,
    );
  });

  it("takes the session limit from the server's ready message", () => {
    expect(initialVoiceCaptureState.sessionMs).toBe(15_000);
    expect(run(GRANTED).sessionMs).toBe(9_000);
  });

  it("drops a session that was still running when the app went to the background", () => {
    expect(run([...GRANTED, { type: "backgrounded" }])).toEqual(
      initialVoiceCaptureState,
    );
    expect(run([{ type: "requested" }, { type: "backgrounded" }])).toEqual(
      initialVoiceCaptureState,
    );
  });

  it("keeps a settled result when the app goes to the background", () => {
    const finished = run([
      ...GRANTED,
      { type: "final", text: "дві пачки", endedBy: "client" },
    ]);
    expect(run([{ type: "backgrounded" }], finished)).toBe(finished);

    const denied = run([{ type: "requested" }, { type: "permissionDenied" }]);
    expect(run([{ type: "backgrounded" }], denied)).toBe(denied);

    const failed = run([...GRANTED, { type: "failed", failure: "network" }]);
    expect(run([{ type: "backgrounded" }], failed)).toBe(failed);
  });
});
