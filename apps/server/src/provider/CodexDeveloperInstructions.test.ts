import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
  codexAgentInstructionEntries,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
  ])("with runtime $model", (runtime) => {
    it.each([undefined, { browser: true, device: true }])(
      "keeps every entry within Codex's per-entry cap with tools %j",
      (availability) => {
        const context = buildCodexAdditionalContext(runtime, availability);

        for (const [key, entry] of Object.entries(context)) {
          // Codex counts ceil(UTF-8 bytes / 4) tokens, excluding keys and wrappers.
          const bytes = Buffer.byteLength(entry.value, "utf8");
          const limit = CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES;
          NodeAssert.ok(
            bytes <= limit,
            `${key}: ${bytes} UTF-8 bytes exceeds Codex's ${limit}-byte per-entry cap by ${bytes - limit} bytes; split the instructions into separate entries to avoid silent truncation`,
          );
        }
      },
    );
  });
});

describe("Codex runtime context", () => {
  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex orchestration context", () => {
  it("routes subagents native first, delegate_task for the rest", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(orchestration.includes("use your native tool when the child uses your provider"));
    NodeAssert.ok(orchestration.includes("`run_in_background:false`"));
    NodeAssert.ok(orchestration.includes("A native type running another provider's model"));
    NodeAssert.ok(
      orchestration.includes("Every new delegate review or re-check is a new `delegate_task`"),
    );
    NodeAssert.ok(orchestration.includes("never a `t3_thread_send`"));
    NodeAssert.ok(!orchestration.includes("inheritedOptions"));
    NodeAssert.ok(!orchestration.includes("Prefer native"));
    // The ACP terminal fallback is ACP-only; Codex agents never need it.
    NodeAssert.ok(!orchestration.includes("acp-mcp-call"));
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}

describe("codexAgentInstructionEntries", () => {
  it("splits a 64 KiB block on code-point boundaries into capped entries that rejoin exactly", () => {
    const block = `## T3 Code agent definition\n${"é🦊".repeat(2_000)}\n${"Check the line.\n".repeat(3_300)}`;
    NodeAssert.ok(Buffer.byteLength(block, "utf8") > 64_000);

    const entries = codexAgentInstructionEntries(block);
    const keys = Object.keys(entries);
    NodeAssert.deepEqual(
      keys,
      keys.map((_, index) => `t3_code_agent_${String(index + 1).padStart(4, "0")}`),
    );
    NodeAssert.ok(keys.length >= 17);
    const values = Object.values(entries);
    for (const [index, entry] of values.entries()) {
      NodeAssert.equal(entry.kind, "application");
      const bytes = Buffer.byteLength(entry.value, "utf8");
      NodeAssert.ok(bytes <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES, `${bytes} bytes`);
      if (index < values.length - 1) {
        NodeAssert.ok(bytes > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES - 4, `${bytes} bytes`);
      }
      NodeAssert.ok(!entry.value.includes("\uFFFD"));
    }
    NodeAssert.equal(
      Object.values(entries)
        .map((entry) => entry.value)
        .join(""),
      block,
    );
  });
});
