import assert from "node:assert/strict";
import test from "node:test";
import { buildTravelAdvice } from "../server/travel/advice";
import { LlmAdmissionError, LlmCallGate } from "../server/security/llm_gate";
import type { AdviceRequest } from "../shared/travel.types";

function request(needsStepFree = false): AdviceRequest {
  return {
    request_id: "security-gate-request",
    candidate_set_id: "security-gate-candidates",
    preference: { preference: "balanced", needs_step_free: needsStepFree, note: null },
    candidates: [
      {
        route_id: "route-1",
        mode: "walking",
        distance_m: 800,
        estimated_duration_s: 600,
        walking_distance_m: 800,
        transfer_count: 0,
        step_free_evidence: "unknown",
      },
    ],
  };
}

test("共享闸门严格限制并发且 release 幂等", () => {
  const gate = new LlmCallGate({
    maxConcurrency: 2,
    maxCallsPerMinute: 10,
    maxCallsPerUtcDay: 10,
  });
  const release1 = gate.acquire();
  const release2 = gate.acquire();
  assert.throws(() => gate.acquire(), (error: unknown) => {
    assert.ok(error instanceof LlmAdmissionError);
    assert.equal(error.reason, "concurrency");
    return true;
  });
  release1();
  release1();
  const release3 = gate.acquire();
  assert.equal(gate.snapshot().active, 2);
  release2();
  release3();
  assert.equal(gate.snapshot().active, 0);
});

test("分钟滑动窗口和 UTC 日预算在边界后正确释放", () => {
  let now = Date.UTC(2026, 10, 15, 23, 59, 30);
  const minuteGate = new LlmCallGate(
    { maxConcurrency: 1, maxCallsPerMinute: 2, maxCallsPerUtcDay: 10 },
    () => now,
  );
  minuteGate.acquire()();
  minuteGate.acquire()();
  assert.throws(() => minuteGate.acquire(), (error: unknown) => {
    assert.ok(error instanceof LlmAdmissionError);
    assert.equal(error.reason, "minute");
    return true;
  });
  now += 60_001;
  minuteGate.acquire()();

  now = Date.UTC(2026, 10, 15, 23, 59, 59);
  const dayGate = new LlmCallGate(
    { maxConcurrency: 1, maxCallsPerMinute: 10, maxCallsPerUtcDay: 1 },
    () => now,
  );
  dayGate.acquire()();
  assert.throws(() => dayGate.acquire(), (error: unknown) => {
    assert.ok(error instanceof LlmAdmissionError);
    assert.equal(error.reason, "utc_day");
    return true;
  });
  now = Date.UTC(2026, 10, 16, 0, 0, 1);
  dayGate.acquire()();
  assert.equal(dayGate.snapshot().callsTodayUtc, 1);
});

test("达到分钟额度时出行建议明确降级且不产生第二次模型费用", async () => {
  const originalFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  let fetchCalls = 0;
  process.env.LLM_API_KEY = "fake-security-test-key";
  process.env.LLM_MODEL = "fake-security-test-model";
  process.env.LLM_MAX_CONCURRENCY = "2";
  process.env.LLM_MAX_CALLS_PER_MINUTE = "1";
  process.env.LLM_MAX_CALLS_PER_UTC_DAY = "98761";
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                selected_route_id: "route-1",
                reason_codes: ["single_candidate"],
                evidence: [],
                explanation: "当前只有一条候选路线，因此选择 route-1。",
                warnings: [],
              }),
            },
          },
        ],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const first = await buildTravelAdvice(request());
    assert.equal(first.mode, "llm");
    const second = await buildTravelAdvice(request());
    assert.equal(second.mode, "rules");
    assert.equal(second.degraded_from, "llm");
    assert.ok(second.warnings.some((warning) => warning.includes("每分钟调用额度")));
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  }
});

test("无台阶硬需求没有已核实候选时直接规则决策，不调用模型", async () => {
  const originalFetch = globalThis.fetch;
  const oldKey = process.env.LLM_API_KEY;
  const oldModel = process.env.LLM_MODEL;
  let fetchCalls = 0;
  process.env.LLM_API_KEY = "fake-security-test-key";
  process.env.LLM_MODEL = "fake-security-test-model";
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("must not be called");
  }) as typeof fetch;

  try {
    const result = await buildTravelAdvice(request(true));
    assert.equal(result.mode, "rules");
    assert.equal(result.degraded_from, null);
    assert.equal(result.selected_route_id, null);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = oldModel;
  }
});

