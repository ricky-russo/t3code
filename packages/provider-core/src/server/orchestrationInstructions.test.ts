import { assert, it } from "@effect/vitest";

import {
  t3AcpPromptWithInstructions,
  t3AgentInstructionsBlock,
  t3CursorPromptWithInstructions,
} from "./orchestrationInstructions.ts";

it("renders the agent definition with escaped attributes and a verbatim body", () => {
  const instructions =
    '# Reviewer\n\n<rules kind="strict">Read ../docs/review.md & stop.</rules>\n';
  const block = t3AgentInstructionsBlock({
    name: 'say "hi" <now>',
    path: "/repo/.claude/agents/reviewer.md",
    instructions,
  });
  assert.isTrue(block.startsWith("## T3 Code agent definition\n"));
  assert.include(
    block,
    'You are running as the agent "say "hi" <now>", defined in /repo/.claude/agents/reviewer.md.',
  );
  assert.include(block, "including after context compaction");
  assert.isTrue(
    block.endsWith(
      `<agent_definition name="say &quot;hi&quot; &lt;now&gt;" path="/repo/.claude/agents/reviewer.md">\n${instructions}\n</agent_definition>`,
    ),
  );
});

it("sends the agent definition to ACP agents without T3 MCP and skips it once the state is unchanged", () => {
  const agentInstructions = t3AgentInstructionsBlock({
    name: "reviewer",
    path: "/repo/.claude/agents/reviewer.md",
    instructions: "Check every changed line.",
  });
  const state = { interactionMode: "default" as const, hasT3Mcp: false, agentInstructions };
  const first = t3AcpPromptWithInstructions({ prompt: "Review the diff.", state });
  assert.include(first, "T3 Code interaction mode: Default");
  assert.notInclude(first, "## T3 Code orchestration");
  assert.include(first, `${agentInstructions}\n</t3_code_instructions>`);
  assert.include(first, "<user_request>\nReview the diff.\n</user_request>");
  assert.equal(
    t3AcpPromptWithInstructions({ prompt: "Keep going.", state, previousState: state }),
    "Keep going.",
  );
  assert.equal(t3AcpPromptWithInstructions({ prompt: "/compact", state }), "/compact");
});

it("wraps a pending Cursor prompt with the agent definition even without T3 MCP", () => {
  const agentInstructions = t3AgentInstructionsBlock({
    name: "reviewer",
    path: "/repo/.claude/agents/reviewer.md",
    instructions: "Check every changed line.",
  });
  assert.deepEqual(
    t3CursorPromptWithInstructions({
      prompt: "Review the diff.",
      pending: true,
      hasT3Mcp: false,
      agentInstructions,
    }),
    {
      text: `<t3_code_orchestration_instructions>${agentInstructions}</t3_code_orchestration_instructions>\n\n<user_request>\nReview the diff.\n</user_request>`,
      delivered: true,
    },
  );
  const withMcp = t3CursorPromptWithInstructions({
    prompt: "Review the diff.",
    pending: true,
    hasT3Mcp: true,
    agentInstructions,
  }).text;
  assert.isBelow(withMcp.indexOf("## T3 Code orchestration"), withMcp.indexOf(agentInstructions));
  assert.deepEqual(
    t3CursorPromptWithInstructions({
      prompt: "Keep going.",
      pending: false,
      hasT3Mcp: true,
      agentInstructions,
    }),
    { text: "Keep going.", delivered: false },
  );
  assert.deepEqual(
    t3CursorPromptWithInstructions({ prompt: "Plain.", pending: true, hasT3Mcp: false }),
    { text: "Plain.", delivered: false },
  );
});
