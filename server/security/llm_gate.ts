export type LlmLimitReason = "concurrency" | "minute" | "utc_day";

export interface LlmGateConfig {
  maxConcurrency: number;
  maxCallsPerMinute: number;
  maxCallsPerUtcDay: number;
}

export interface LlmGateSnapshot {
  active: number;
  callsInLastMinute: number;
  callsTodayUtc: number;
  utcDay: string;
}

export class LlmAdmissionError extends Error {
  constructor(
    public readonly reason: LlmLimitReason,
    message: string,
  ) {
    super(message);
    this.name = "LlmAdmissionError";
  }
}

export function isLlmAdmissionError(error: unknown): error is LlmAdmissionError {
  return error instanceof LlmAdmissionError;
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * 单 Node 进程内的共享模型调用闸门。
 *
 * 计数发生在 permit 发放时，失败的供应商调用同样消耗分钟/日预算；release 只释放并发槽位。
 * JavaScript 同步执行 acquire 的状态变更，因此同一进程内不会出现 await 间隙的超发竞态。
 */
export class LlmCallGate {
  private active = 0;
  private recentCalls: number[] = [];
  private currentUtcDay = "";
  private callsTodayUtc = 0;

  constructor(
    private readonly config: LlmGateConfig,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
    if (!Number.isInteger(config.maxCallsPerMinute) || config.maxCallsPerMinute < 1) {
      throw new RangeError("maxCallsPerMinute must be a positive integer");
    }
    if (!Number.isInteger(config.maxCallsPerUtcDay) || config.maxCallsPerUtcDay < 1) {
      throw new RangeError("maxCallsPerUtcDay must be a positive integer");
    }
  }

  acquire(): () => void {
    const nowMs = this.now();
    this.refreshWindows(nowMs);

    if (this.active >= this.config.maxConcurrency) {
      throw new LlmAdmissionError("concurrency", "模型并发已达上限，已切换规则模式");
    }
    if (this.recentCalls.length >= this.config.maxCallsPerMinute) {
      throw new LlmAdmissionError("minute", "模型每分钟调用额度已用尽，已切换规则模式");
    }
    if (this.callsTodayUtc >= this.config.maxCallsPerUtcDay) {
      throw new LlmAdmissionError("utc_day", "模型当日调用额度已用尽，已切换规则模式");
    }

    this.active += 1;
    this.recentCalls.push(nowMs);
    this.callsTodayUtc += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }

  snapshot(): LlmGateSnapshot {
    const nowMs = this.now();
    this.refreshWindows(nowMs);
    return {
      active: this.active,
      callsInLastMinute: this.recentCalls.length,
      callsTodayUtc: this.callsTodayUtc,
      utcDay: this.currentUtcDay,
    };
  }

  private refreshWindows(nowMs: number): void {
    const cutoff = nowMs - 60_000;
    this.recentCalls = this.recentCalls.filter((timestamp) => timestamp > cutoff);

    const day = utcDay(nowMs);
    if (day !== this.currentUtcDay) {
      this.currentUtcDay = day;
      this.callsTodayUtc = 0;
    }
  }
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function llmGateConfigFromEnv(): LlmGateConfig {
  return {
    maxConcurrency: envInteger("LLM_MAX_CONCURRENCY", 2, 1, 32),
    maxCallsPerMinute: envInteger("LLM_MAX_CALLS_PER_MINUTE", 12, 1, 10_000),
    maxCallsPerUtcDay: envInteger("LLM_MAX_CALLS_PER_UTC_DAY", 200, 1, 1_000_000),
  };
}

const sharedGates = new Map<string, LlmCallGate>();

/** 同一进程、同一配置签名共用计数；环境变量变化只会切换到另一个受限闸门。 */
export function acquireLlmCallPermit(): () => void {
  const config = llmGateConfigFromEnv();
  const signature = `${config.maxConcurrency}:${config.maxCallsPerMinute}:${config.maxCallsPerUtcDay}`;
  let gate = sharedGates.get(signature);
  if (!gate) {
    gate = new LlmCallGate(config);
    sharedGates.set(signature, gate);
  }
  return gate.acquire();
}

