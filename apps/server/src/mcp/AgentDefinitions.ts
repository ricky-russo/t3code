import {
  DELEGATED_AGENT_INSTRUCTIONS_MAX_BYTES,
  DELEGATED_AGENT_NAME_MAX_LENGTH,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { splitMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

const AGENT_DIRECTORIES = [".agents/agents", ".claude/agents", ".cursor/agents"];
const KNOWN_NAMES_LIMIT = 20;
const OPENING_FENCE = /^---\r?\n/;

export interface AgentDefinition {
  readonly name: string;
  readonly path: string;
  readonly scope: "project" | "user";
  readonly description?: string;
  readonly instructions: string;
}

export class AgentDefinitionNotFoundError extends Schema.TaggedError<AgentDefinitionNotFoundError>()(
  "AgentDefinitionNotFoundError",
  { name: Schema.String, known: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return this.known.length === 0
      ? `No agent definition named "${this.name}". None exist in ${AGENT_DIRECTORIES.join(", ")} of the checkout or home directory.`
      : `No agent definition named "${this.name}". Known: ${this.known.join(", ")}.`;
  }
}

const INVALID_REASONS = {
  malformed_frontmatter: "has frontmatter that is unclosed or not a YAML mapping",
  name_mismatch: "has a frontmatter name that differs from its file name",
  empty_instructions: "has no instructions after its frontmatter",
  too_large: "is larger than 64 KiB",
  unreadable: "cannot be read",
} as const;

export class AgentDefinitionInvalidError extends Schema.TaggedError<AgentDefinitionInvalidError>()(
  "AgentDefinitionInvalidError",
  {
    name: Schema.String,
    path: Schema.String,
    reason: Schema.Literals([
      "malformed_frontmatter",
      "name_mismatch",
      "empty_instructions",
      "too_large",
      "unreadable",
    ]),
  },
) {
  override get message(): string {
    return `Agent definition "${this.name}" at ${this.path} ${INVALID_REASONS[this.reason]}.`;
  }
}

export class AgentDefinitions extends Context.Service<
  AgentDefinitions,
  {
    /** Valid definitions visible from `cwd`, sorted by name. Without `cwd`, only user definitions. */
    readonly list: (input: {
      readonly cwd: string | undefined;
    }) => Effect.Effect<ReadonlyArray<AgentDefinition>>;
    /** An invalid file that wins its name fails rather than falling through to a lower root. */
    readonly resolve: (input: {
      readonly cwd: string | undefined;
      readonly name: string;
    }) => Effect.Effect<
      AgentDefinition,
      AgentDefinitionNotFoundError | AgentDefinitionInvalidError
    >;
  }
>()("t3/mcp/AgentDefinitions") {}

type IndexedAgent = AgentDefinition | AgentDefinitionInvalidError;

const isInvalid = Schema.is(AgentDefinitionInvalidError);

const definitionsByName = (agents: ReadonlyMap<string, IndexedAgent>) =>
  [...agents.values()]
    .filter((agent): agent is AgentDefinition => !isInvalid(agent))
    .toSorted((a, b) => a.name.localeCompare(b.name));

function stringField(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Scans run inside the list and resolve spans; per-file spans would only add noise.
  const readAgentFile = Effect.fnUntraced(function* (
    filePath: string,
    scope: AgentDefinition["scope"],
  ) {
    const name = path.basename(filePath, ".md");
    const realPath = yield* fileSystem
      .realPath(filePath)
      .pipe(Effect.orElseSucceed(() => filePath));
    const invalid = (reason: AgentDefinitionInvalidError["reason"]) =>
      new AgentDefinitionInvalidError({ name, path: realPath, reason });
    const info = yield* fileSystem.stat(realPath).pipe(Effect.orElseSucceed(() => undefined));
    if (info === undefined) return invalid("unreadable");
    if (info.type !== "File") return undefined;
    if (Number(info.size) > DELEGATED_AGENT_INSTRUCTIONS_MAX_BYTES) return invalid("too_large");
    const contents = yield* fileSystem
      .readFileString(realPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) return invalid("unreadable");
    const frontmatter = splitMarkdownFrontmatter(contents);
    if (
      frontmatter.kind === "malformed" ||
      (frontmatter.kind === "none" && OPENING_FENCE.test(contents))
    ) {
      return invalid("malformed_frontmatter");
    }
    const fields = frontmatter.kind === "parsed" ? frontmatter.fields : {};
    const declaredName = stringField(fields.name);
    if (declaredName !== undefined && declaredName !== name) return invalid("name_mismatch");
    const instructions = frontmatter.body.trim();
    if (instructions === "") return invalid("empty_instructions");
    const description = stringField(fields.description);
    return {
      name,
      path: realPath,
      scope,
      ...(description === undefined ? {} : { description }),
      instructions,
    } satisfies AgentDefinition;
  });

  const index = Effect.fnUntraced(function* (cwd: string | undefined) {
    const home = yield* HostProcess.HomeDirectory;
    const roots = [
      ...(cwd === undefined
        ? []
        : AGENT_DIRECTORIES.map((directory) => ({
            directory: path.join(cwd, directory),
            scope: "project" as const,
          }))),
      ...AGENT_DIRECTORIES.map((directory) => ({
        directory: path.join(home, directory),
        scope: "user" as const,
      })),
    ];
    const agents = new Map<string, IndexedAgent>();
    for (const root of roots) {
      const files = yield* fileSystem
        .readDirectory(root.directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const file of files.toSorted()) {
        const name = path.basename(file, ".md");
        if (!file.endsWith(".md") || name.length > DELEGATED_AGENT_NAME_MAX_LENGTH) continue;
        if (agents.has(name)) continue;
        const agent = yield* readAgentFile(path.join(root.directory, file), root.scope);
        if (agent !== undefined) agents.set(name, agent);
      }
    }
    return agents;
  });

  const list: AgentDefinitions["Service"]["list"] = Effect.fn("AgentDefinitions.list")(
    function* (input) {
      return definitionsByName(yield* index(input.cwd));
    },
  );

  const resolve: AgentDefinitions["Service"]["resolve"] = Effect.fn("AgentDefinitions.resolve")(
    function* (input) {
      const agents = yield* index(input.cwd);
      const agent = agents.get(input.name);
      if (agent === undefined) {
        return yield* new AgentDefinitionNotFoundError({
          name: input.name,
          known: definitionsByName(agents)
            .slice(0, KNOWN_NAMES_LIMIT)
            .map((definition) => definition.name),
        });
      }
      if (isInvalid(agent)) return yield* agent;
      return agent;
    },
  );

  return AgentDefinitions.of({ list, resolve });
});

export const layer = Layer.effect(AgentDefinitions, make);
