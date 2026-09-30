export interface Sho740Rates {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheWriteMultiplier: number;
  readonly cacheReadMultiplier: number;
}

export const SHO_740_HAIKU_RATES: Sho740Rates = {
  inputPerMTok: 1,
  outputPerMTok: 5,
  cacheWriteMultiplier: 1.25,
  cacheReadMultiplier: 0.1,
};

export interface Sho740Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

export function sho740CostUsd(
  usage: Sho740Usage,
  rates: Sho740Rates = SHO_740_HAIKU_RATES,
): number {
  const input = rates.inputPerMTok / 1_000_000;
  return (
    usage.inputTokens * input +
    usage.outputTokens * (rates.outputPerMTok / 1_000_000) +
    usage.cacheWriteTokens * input * rates.cacheWriteMultiplier +
    usage.cacheReadTokens * input * rates.cacheReadMultiplier
  );
}

export class Sho740BudgetExhaustedError extends Error {
  constructor(
    readonly provider: string,
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `${provider} budget exhausted: $${spentUsd.toFixed(4)} spent of a $${capUsd.toFixed(2)} cap`,
    );
    this.name = "Sho740BudgetExhaustedError";
  }
}

export class Sho740Ledger {
  private spent = 0;
  private calls = 0;
  private readonly usage: Sho740Usage[] = [];

  constructor(
    readonly provider: string,
    readonly capUsd: number,
    private readonly headroomUsd: number,
  ) {}

  get spentUsd(): number {
    return this.spent;
  }

  get callCount(): number {
    return this.calls;
  }

  get totals(): Sho740Usage {
    return this.usage.reduce<Sho740Usage>(
      (sum, entry) => ({
        inputTokens: sum.inputTokens + entry.inputTokens,
        outputTokens: sum.outputTokens + entry.outputTokens,
        cacheWriteTokens: sum.cacheWriteTokens + entry.cacheWriteTokens,
        cacheReadTokens: sum.cacheReadTokens + entry.cacheReadTokens,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
    );
  }

  canAfford(): boolean {
    return this.spent + this.headroomUsd <= this.capUsd;
  }

  require(): void {
    if (!this.canAfford()) {
      throw new Sho740BudgetExhaustedError(
        this.provider,
        this.spent,
        this.capUsd,
      );
    }
  }

  charge(usage: Sho740Usage, rates: Sho740Rates = SHO_740_HAIKU_RATES): number {
    const cost = sho740CostUsd(usage, rates);
    this.spent += cost;
    this.calls += 1;
    this.usage.push(usage);
    return cost;
  }
}
