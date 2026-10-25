import { assert, it } from "@effect/vitest";

import { t3AgentInstructionsBlock } from "./orchestrationInstructions.ts";

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
