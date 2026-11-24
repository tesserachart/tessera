export interface RestartPolicyOptions {
  baseMs?: number;
  maxMs?: number;
}

export interface RestartDecision {
  delayMs: number;
  repeated: boolean;
}

export class RestartPolicy {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private failures = 0;
  private lastFailure: string | null = null;

  constructor(options: RestartPolicyOptions = {}) {
    this.baseMs = options.baseMs ?? 1000;
    this.maxMs = options.maxMs ?? 30_000;
  }

  ready(): void {
    this.failures = 0;
    this.lastFailure = null;
  }

  exitedAfterReady(): RestartDecision {
    return { delayMs: this.delayMs(), repeated: false };
  }

  failedBeforeReady(output: string): RestartDecision {
    const delayMs = this.delayMs();
    this.failures++;
    const repeated = this.lastFailure === output;
    this.lastFailure = output;
    return { delayMs, repeated };
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  private delayMs(): number {
    return Math.min(this.maxMs, this.baseMs * 2 ** this.failures);
  }
}
