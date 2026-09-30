export type Spread = { p50: number; p90: number; max: number };

/** How long the stages of one publish took, in milliseconds. */
export type PublishTiming = {
  preWriteReadMs: number;
  checkpointWriteMs: number;
  feedWriteMs: number;
  receivedToWrittenMs: number;
};

export type PublishTimingSummary = { samples: number } & { [Stage in keyof PublishTiming]: Spread };

const STAGES = ['preWriteReadMs', 'checkpointWriteMs', 'feedWriteMs', 'receivedToWrittenMs'] as const;

/** The most recent publishes' timings, reported on /health as observations and never used to decide anything. */
export class PublishTimings {
  private readonly recent: PublishTiming[] = [];

  constructor(private readonly limit = 500) {}

  record(timing: PublishTiming): void {
    this.recent.push(timing);
    if (this.recent.length > this.limit) {
      this.recent.shift();
    }
  }

  summary(): PublishTimingSummary | null {
    if (this.recent.length === 0) {
      return null;
    }
    const spreads = Object.fromEntries(
      STAGES.map((stage) => [stage, spread(this.recent.map((timing) => timing[stage]))]),
    ) as { [Stage in keyof PublishTiming]: Spread };
    return { samples: this.recent.length, ...spreads };
  }
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return { p50: Math.round(at(0.5)), p90: Math.round(at(0.9)), max: Math.round(sorted.at(-1) ?? 0) };
}
