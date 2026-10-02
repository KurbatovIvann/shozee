import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import type { WireActionPreview, WireActionRisk } from "@showzy/contract";

import type { ConfirmDialogChoice } from "../components/ui/confirm-dialog";
import {
  confirmationChallenge,
  submitWithProtocolConfirmation,
  type ConfirmationChallengeView,
} from "./protocol-confirm";

const PREVIEW: WireActionPreview = {
  title: "Видалити клієнта?",
  lines: [
    { label: "Клієнт", value: "ТОВ «Ромашка»" },
    { label: "Замовлень", value: "12" },
  ],
  notes: ["Цю дію не можна скасувати."],
};

function confirmationRequired(
  challengeId: string,
  preview?: WireActionPreview,
  risk: WireActionRisk = "write",
): ORPCError<
  "CONFIRMATION_REQUIRED",
  {
    challenge: {
      challengeId: string;
      summary: string;
      expiresAt: string;
      risk: WireActionRisk;
      preview?: WireActionPreview;
    };
  }
> {
  return new ORPCError("CONFIRMATION_REQUIRED", {
    defined: true,
    status: 409,
    message: "Confirm.",
    data: {
      challenge: {
        challengeId,
        summary: "Delete?",
        expiresAt: "2026-08-28T00:00:00.000Z",
        risk,
        ...(preview === undefined ? {} : { preview }),
      },
    },
  });
}

describe("confirmationChallenge", () => {
  it("carries the structured preview card from CONFIRMATION_REQUIRED", () => {
    expect(
      confirmationChallenge(confirmationRequired("challenge-9", PREVIEW)),
    ).toEqual({
      challengeId: "challenge-9",
      summary: "Delete?",
      risk: "write",
      preview: PREVIEW,
    });
  });

  it("falls back to the summary when the action binds no preview", () => {
    expect(confirmationChallenge(confirmationRequired("challenge-9"))).toEqual({
      challengeId: "challenge-9",
      summary: "Delete?",
      risk: "write",
    });
  });

  it("carries the challenged action's risk for the card tone", () => {
    expect(
      confirmationChallenge(
        confirmationRequired("challenge-9", PREVIEW, "high"),
      )?.risk,
    ).toBe("high");
  });

  it("returns null when the error is not CONFIRMATION_REQUIRED", () => {
    expect(confirmationChallenge(new TypeError("Failed to fetch"))).toBeNull();
    expect(
      confirmationChallenge(
        new ORPCError("PERMISSION_DENIED", {
          defined: true,
          status: 403,
          message: "Denied.",
        }),
      ),
    ).toBeNull();
  });
});

describe("submitWithProtocolConfirmation", () => {
  it("returns the submit result and never presents when unchallenged", async () => {
    const present = vi.fn(() => Promise.resolve("confirm" as const));
    const result = await submitWithProtocolConfirmation({
      submit: () => Promise.resolve("ok"),
      present,
      confirm: () => Promise.reject(new Error("must not confirm")),
    });

    expect(result).toEqual({ outcome: "submitted", value: "ok" });
    expect(present).not.toHaveBeenCalled();
  });

  it("presents the server card and confirms only on approve", async () => {
    const seen: ConfirmationChallengeView[] = [];
    const sent: string[] = [];
    const result = await submitWithProtocolConfirmation({
      submit: () => Promise.reject(confirmationRequired("ch-1", PREVIEW)),
      present: (challenge) => {
        seen.push(challenge);
        return Promise.resolve("confirm");
      },
      confirm: (challengeId) => {
        sent.push(challengeId);
        return Promise.resolve("deleted");
      },
    });

    expect(seen).toEqual([
      {
        challengeId: "ch-1",
        summary: "Delete?",
        risk: "write",
        preview: PREVIEW,
      },
    ]);
    expect(sent).toEqual(["ch-1"]);
    expect(result).toEqual({ outcome: "submitted", value: "deleted" });
  });

  it("sends nothing when the person declines", async () => {
    const confirm = vi.fn(() => Promise.resolve("deleted"));
    const result = await submitWithProtocolConfirmation({
      submit: () => Promise.reject(confirmationRequired("ch-2")),
      present: () => Promise.resolve("cancel"),
      confirm,
    });

    expect(result).toEqual({ outcome: "declined" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rethrows a failure that is not a confirmation challenge", async () => {
    await expect(
      submitWithProtocolConfirmation({
        submit: () => Promise.reject(new TypeError("Failed to fetch")),
        present: () => Promise.resolve("confirm"),
        confirm: () => Promise.resolve("deleted"),
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("presents the drifted card and executes once on the second approve", async () => {
    const seen: ConfirmationChallengeView[] = [];
    const sent: string[] = [];
    const drifted: WireActionPreview = {
      title: "Видалити клієнта?",
      lines: [{ label: "Замовлень", value: "13" }],
      notes: [],
    };
    const result = await submitWithProtocolConfirmation({
      submit: () => Promise.reject(confirmationRequired("ch-1", PREVIEW)),
      present: (challenge) => {
        seen.push(challenge);
        return Promise.resolve("confirm");
      },
      confirm: (challengeId) => {
        sent.push(challengeId);
        return challengeId === "ch-1"
          ? Promise.reject(confirmationRequired("ch-2", drifted))
          : Promise.resolve("deleted");
      },
    });

    expect(seen).toEqual([
      {
        challengeId: "ch-1",
        summary: "Delete?",
        risk: "write",
        preview: PREVIEW,
      },
      {
        challengeId: "ch-2",
        summary: "Delete?",
        risk: "write",
        preview: drifted,
      },
    ]);
    expect(sent).toEqual(["ch-1", "ch-2"]);
    expect(result).toEqual({ outcome: "submitted", value: "deleted" });
  });

  it("sends nothing more when the person declines the drifted card", async () => {
    const sent: string[] = [];
    const choices: ConfirmDialogChoice[] = ["confirm", "cancel"];
    const result = await submitWithProtocolConfirmation({
      submit: () => Promise.reject(confirmationRequired("ch-1", PREVIEW)),
      present: () => Promise.resolve(choices.shift() ?? "cancel"),
      confirm: (challengeId) => {
        sent.push(challengeId);
        return Promise.reject(confirmationRequired("ch-2", PREVIEW));
      },
    });

    expect(result).toEqual({ outcome: "declined" });
    expect(sent).toEqual(["ch-1"]);
  });

  it("keeps presenting repeated drift only while the person approves", async () => {
    const seen: string[] = [];
    const sent: string[] = [];
    let issued = 1;
    const result = await submitWithProtocolConfirmation({
      submit: () => Promise.reject(confirmationRequired("ch-1", PREVIEW)),
      present: (challenge) => {
        seen.push(challenge.challengeId);
        return Promise.resolve(seen.length < 4 ? "confirm" : "cancel");
      },
      confirm: (challengeId) => {
        sent.push(challengeId);
        issued += 1;
        return Promise.reject(
          confirmationRequired(`ch-${String(issued)}`, PREVIEW),
        );
      },
    });

    expect(seen).toEqual(["ch-1", "ch-2", "ch-3", "ch-4"]);
    expect(sent).toEqual(["ch-1", "ch-2", "ch-3"]);
    expect(result).toEqual({ outcome: "declined" });
  });

  it("rethrows a non-confirmation failure raised by the confirm step", async () => {
    const seen: string[] = [];
    await expect(
      submitWithProtocolConfirmation({
        submit: () => Promise.reject(confirmationRequired("ch-1", PREVIEW)),
        present: (challenge) => {
          seen.push(challenge.challengeId);
          return Promise.resolve("confirm");
        },
        confirm: () =>
          Promise.reject(
            new ORPCError("PERMISSION_DENIED", {
              defined: true,
              status: 403,
              message: "Denied.",
            }),
          ),
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(seen).toEqual(["ch-1"]);
  });

  it("keeps the card retryable when the confirm step fails on the network", async () => {
    const presented: string[] = [];
    let confirmAttempts = 0;
    const run = () =>
      submitWithProtocolConfirmation({
        submit: () => Promise.reject(confirmationRequired("ch-3", PREVIEW)),
        present: (challenge) => {
          presented.push(challenge.challengeId);
          return Promise.resolve("confirm");
        },
        confirm: (challengeId) => {
          confirmAttempts += 1;
          return confirmAttempts === 1
            ? Promise.reject(new TypeError("Failed to fetch"))
            : Promise.resolve(`deleted:${challengeId}`);
        },
      });

    await expect(run()).rejects.toBeInstanceOf(TypeError);
    await expect(run()).resolves.toEqual({
      outcome: "submitted",
      value: "deleted:ch-3",
    });
    expect(presented).toEqual(["ch-3", "ch-3"]);
  });
});
