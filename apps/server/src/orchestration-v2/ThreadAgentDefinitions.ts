import type { OrchestrationV2DelegatedAgent, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ThreadAgentDefinitionsError extends Schema.TaggedError<ThreadAgentDefinitionsError>()(
  "ThreadAgentDefinitionsError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export interface ThreadAgentDefinitionBinding {
  readonly threadId: ThreadId;
  readonly definition: OrchestrationV2DelegatedAgent;
}

export interface ThreadAgentDefinitionCopy {
  readonly from: ThreadId;
  readonly to: ThreadId;
}

/**
 * The agent definition a delegated child runs under, frozen for the thread's life. Server-only
 * and authoritative: it is never event-sourced or streamed, so projection rebuilds must not purge it.
 */
export class ThreadAgentDefinitions extends Context.Service<
  ThreadAgentDefinitions,
  {
    /** Inserts once; a thread already bound keeps its first definition. */
    readonly bind: (
      binding: ThreadAgentDefinitionBinding,
    ) => Effect.Effect<void, ThreadAgentDefinitionsError>;
    /** A no-op when the source has no definition. */
    readonly copy: (
      copy: ThreadAgentDefinitionCopy,
    ) => Effect.Effect<void, ThreadAgentDefinitionsError>;
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<OrchestrationV2DelegatedAgent>, ThreadAgentDefinitionsError>;
  }
>()("t3/orchestration-v2/ThreadAgentDefinitions") {}

export const layer = Layer.effect(
  ThreadAgentDefinitions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fail = (cause: unknown) => new ThreadAgentDefinitionsError({ cause });

    const bind = Effect.fn("ThreadAgentDefinitions.bind")(function* (
      binding: ThreadAgentDefinitionBinding,
    ) {
      const { name, path, instructions } = binding.definition;
      yield* sql`
        INSERT INTO thread_agent_definitions (thread_id, name, path, instructions)
        VALUES (${binding.threadId}, ${name}, ${path}, ${instructions})
        ON CONFLICT(thread_id) DO NOTHING
      `.pipe(Effect.mapError(fail));
    });

    const copy = Effect.fn("ThreadAgentDefinitions.copy")(function* (
      copy: ThreadAgentDefinitionCopy,
    ) {
      yield* sql`
        INSERT INTO thread_agent_definitions (thread_id, name, path, instructions)
        SELECT ${copy.to}, name, path, instructions
        FROM thread_agent_definitions
        WHERE thread_id = ${copy.from}
        ON CONFLICT(thread_id) DO NOTHING
      `.pipe(Effect.mapError(fail));
    });

    const forThread = Effect.fn("ThreadAgentDefinitions.forThread")(function* (threadId: ThreadId) {
      const rows = yield* sql<OrchestrationV2DelegatedAgent>`
        SELECT name, path, instructions FROM thread_agent_definitions WHERE thread_id = ${threadId}
      `.pipe(NodeSqliteClient.readOnly, Effect.mapError(fail));
      return Option.fromNullishOr(rows[0]);
    });

    return ThreadAgentDefinitions.of({ bind, copy, forThread });
  }),
);

export const layerEmpty = Layer.succeed(
  ThreadAgentDefinitions,
  ThreadAgentDefinitions.of({
    bind: () => Effect.void,
    copy: () => Effect.void,
    forThread: () => Effect.succeed(Option.none()),
  }),
);
