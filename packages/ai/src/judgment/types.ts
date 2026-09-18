import { JUDGMENT_REFUSAL_REASONS } from "@showzy/validation/assistant-judgment";

export type JudgmentJson =
  | string
  | number
  | boolean
  | null
  | JudgmentJson[]
  | { readonly [key: string]: JudgmentJson };

export type JudgmentText =
  string | JudgmentJson[] | { readonly [key: string]: JudgmentJson };

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: JudgmentText;
  readonly criteria?: {
    readonly true?: JudgmentText;
    readonly false?: JudgmentText;
  };
}

export interface ChoiceQuestion<Label extends string = string> {
  readonly type: "choice";
  readonly instructions: JudgmentText;
  readonly criteria: Readonly<Record<Label, JudgmentText | null>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: JudgmentText;
  readonly criteria: readonly [JudgmentText, JudgmentText, ...JudgmentText[]];
}

export type JudgmentQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type JudgmentQuestions = Readonly<Record<string, JudgmentQuestion>>;

export interface NoulAnswer {
  readonly type: "noul";
  readonly probability: number;
}

export interface ChoiceAnswer<Label extends string = string> {
  readonly type: "choice";
  readonly choice: Label;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<Label, number>>;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly confidence: number;
  readonly probabilities: readonly number[];
}

export type JudgmentAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type JudgmentAnswerFor<Q extends JudgmentQuestion> =
  Q extends NoulQuestion
    ? NoulAnswer
    : Q extends ChoiceQuestion<infer Label>
      ? ChoiceAnswer<Label>
      : Q extends ScoreQuestion
        ? ScoreAnswer
        : never;

export type JudgmentAnswers<Q extends JudgmentQuestions> = {
  readonly [K in keyof Q]: JudgmentAnswerFor<Q[K]>;
};

export { JUDGMENT_REFUSAL_REASONS };

export type JudgmentRefusalReason = (typeof JUDGMENT_REFUSAL_REASONS)[number];

export interface JudgmentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface JudgmentAnswered<Q extends JudgmentQuestions> {
  readonly ok: true;
  readonly model: string;
  readonly answers: JudgmentAnswers<Q>;
  readonly usage: JudgmentUsage;
}

export interface JudgmentRefused {
  readonly ok: false;
  readonly reason: JudgmentRefusalReason;
  readonly status?: number;
  readonly requestId?: string;
}

export type JudgmentResult<Q extends JudgmentQuestions> =
  JudgmentAnswered<Q> | JudgmentRefused;

export interface JudgmentRequest<Q extends JudgmentQuestions> {
  readonly state: JudgmentText;
  readonly questions: Q;
}

export interface JudgmentAskOptions {
  readonly signal?: AbortSignal;
}

export interface JudgmentProvider {
  readonly id: string;
  readonly model: string;
  ask<const Q extends JudgmentQuestions>(
    request: JudgmentRequest<Q>,
    options?: JudgmentAskOptions,
  ): Promise<JudgmentResult<Q>>;
}
