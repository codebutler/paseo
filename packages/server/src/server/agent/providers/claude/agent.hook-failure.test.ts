import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";

/**
 * A hook that fails reports through a `hook_response` frame. Those frames used
 * to stop at the daemon, so a setup hook that failed to install a dependency
 * was invisible in the timeline and in daemon.log.
 */

function buildQueryMock(events: unknown[]) {
  let index = 0;
  return {
    next: vi.fn(async () => {
      if (index >= events.length) return { done: true, value: undefined };
      const value = events[index];
      index += 1;
      return { done: false, value };
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    applyFlagSettings: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    getContextUsage: vi.fn(async () => undefined),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      break;
    }
  }
  return events;
}

const INIT_FRAME = {
  type: "system",
  subtype: "init",
  session_id: "hook-session",
  permissionMode: "default",
};

const RESULT_FRAME = {
  type: "result",
  subtype: "success",
  usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  total_cost_usd: 0,
};

function hookResponse(overrides: Record<string, unknown>) {
  return {
    type: "system",
    subtype: "hook_response",
    hook_id: "hook-1",
    hook_name: "SessionStart:startup",
    hook_event: "SessionStart",
    output: "",
    stdout: "",
    stderr: "",
    exit_code: 0,
    outcome: "success",
    uuid: "11111111-1111-1111-1111-111111111111",
    session_id: "hook-session",
    ...overrides,
  };
}

async function runWithHookFrame(frame: Record<string, unknown>): Promise<AgentStreamEvent[]> {
  const queryFactory = vi.fn(() => buildQueryMock([INIT_FRAME, frame, RESULT_FRAME]));
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const events = await collectUntilTerminal(streamSession(session, "start up"));
  await session.close();
  return events;
}

function errorItems(events: AgentStreamEvent[]): AgentStreamEvent[] {
  return events.filter((event) => event.type === "timeline" && event.item.type === "error");
}

describe("Claude hook failure", () => {
  test("reports a hook that exits non-zero", async () => {
    const events = await runWithHookFrame(
      hookResponse({
        stderr: "[hook] Failed to install bandit",
        exit_code: 1,
        outcome: "error",
      }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: {
          type: "error",
          message: "Hook SessionStart:startup failed: [hook] Failed to install bandit",
        },
      }),
    );
  });

  test("reports a setup hook that warns on stderr and exits 0", async () => {
    // Verified against Claude Code 2.1.246: `... || echo 'warning' >&2` reports
    // outcome "success" with exit code 0, which is how the bandit warning hid.
    const events = await runWithHookFrame(
      hookResponse({ stderr: "[hook] Failed to install bandit\n" }),
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: {
          type: "error",
          message: "Hook SessionStart:startup reported: [hook] Failed to install bandit",
        },
      }),
    );
  });

  test("ignores stderr from a tool hook that succeeded", async () => {
    const events = await runWithHookFrame(
      hookResponse({
        hook_id: "hook-2",
        hook_name: "PreToolUse:Bash",
        hook_event: "PreToolUse",
        output: "{}",
        stdout: "{}",
        stderr: "checked 3 modules",
      }),
    );

    expect(errorItems(events)).toEqual([]);
  });

  test("stays quiet when a hook succeeds", async () => {
    const events = await runWithHookFrame(
      hookResponse({ hook_id: "hook-3", output: "{}", stdout: "{}" }),
    );

    expect(errorItems(events)).toEqual([]);
  });
});
