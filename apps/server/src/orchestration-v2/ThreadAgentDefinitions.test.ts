import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ThreadAgentDefinitions from "./ThreadAgentDefinitions.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(
  Layer.merge(database, ThreadAgentDefinitions.layer.pipe(Layer.provide(database))),
);

const childId = ThreadId.make("thread:agent-child");
const forkId = ThreadId.make("thread:agent-fork");
const plainId = ThreadId.make("thread:agent-plain");
const reviewer = {
  name: "reviewer",
  path: "/repo/.claude/agents/reviewer.md",
  instructions: "# Reviewer\n\nCheck every changed line. Ünïcödé stays intact.",
};

layer("ThreadAgentDefinitions", (it) => {
  it.effect("binds a definition once and copies it to a fork", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* ThreadAgentDefinitions.ThreadAgentDefinitions;
      assert.deepEqual(yield* store.forThread(childId), Option.none());

      yield* store.bind({ threadId: childId, definition: reviewer });
      yield* store.bind({
        threadId: childId,
        definition: { ...reviewer, instructions: "A later bind must not win." },
      });
      assert.deepEqual(yield* store.forThread(childId), Option.some(reviewer));

      yield* store.copy({ from: childId, to: forkId });
      assert.deepEqual(yield* store.forThread(forkId), Option.some(reviewer));

      yield* store.copy({ from: plainId, to: ThreadId.make("thread:agent-plain-fork") });
      assert.deepEqual(
        yield* store.forThread(ThreadId.make("thread:agent-plain-fork")),
        Option.none(),
      );
    }),
  );
});
