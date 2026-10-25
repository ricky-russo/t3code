import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as AgentDefinitions from "./AgentDefinitions.ts";

const layerTest = AgentDefinitions.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeRoots = Effect.fn("test.makeRoots")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agent-definitions-" }),
  );
  const cwd = path.join(root, "checkout");
  const home = path.join(root, "home");
  const write = Effect.fn("test.write")(function* (relativePath: string, contents: string) {
    const filePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
    return filePath;
  });
  const service = yield* AgentDefinitions.AgentDefinitions;
  const withHome = Effect.provideService(HostProcess.HomeDirectory, home);
  return {
    root,
    cwd,
    write,
    list: (input: { readonly cwd: string | undefined }) => service.list(input).pipe(withHome),
    resolve: (input: { readonly cwd: string | undefined; readonly name: string }) =>
      service.resolve(input).pipe(withHome),
  };
});

it.layer(layerTest)("AgentDefinitions", (it) => {
  it.effect("prefers .agents, then .claude, then .cursor, and the checkout over home", () =>
    Effect.gen(function* () {
      const roots = yield* makeRoots();
      const winner = yield* roots.write("checkout/.agents/agents/reviewer.md", "Agents copy.");
      yield* roots.write("checkout/.claude/agents/reviewer.md", "Claude copy.");
      yield* roots.write("checkout/.cursor/agents/fixer.md", "Cursor fixer.");
      yield* roots.write("home/.agents/agents/fixer.md", "Home fixer.");
      yield* roots.write("home/.claude/agents/planner.md", "Home planner.");

      assert.deepEqual(yield* roots.resolve({ cwd: roots.cwd, name: "reviewer" }), {
        name: "reviewer",
        path: winner,
        scope: "project",
        instructions: "Agents copy.",
      });
      assert.deepEqual(
        (yield* roots.list({ cwd: roots.cwd })).map(({ name, scope, instructions }) => ({
          name,
          scope,
          instructions,
        })),
        [
          { name: "fixer", scope: "project", instructions: "Cursor fixer." },
          { name: "planner", scope: "user", instructions: "Home planner." },
          { name: "reviewer", scope: "project", instructions: "Agents copy." },
        ],
      );
    }),
  );

  it.effect("names a definition by its file stem, which a frontmatter name must match", () =>
    Effect.gen(function* () {
      const roots = yield* makeRoots();
      yield* roots.write(
        "checkout/.claude/agents/code-reviewer.md",
        "---\nname: code-reviewer\ndescription: Reviews diffs.\nmodel: opus\ntools: Read\n---\n\nReview the diff.\n",
      );
      yield* roots.write("checkout/.claude/agents/plain.md", "No frontmatter.");
      yield* roots.write(
        "checkout/.claude/agents/unnamed.md",
        "---\ndescription: Use when: a Claude-style description has a colon.\n---\nBody.",
      );
      const mismatched = yield* roots.write(
        "checkout/.claude/agents/local-review.md",
        "---\nname: reviewer\n---\nProject review.",
      );
      yield* roots.write("home/.claude/agents/local-review.md", "Home local review.");
      yield* roots.write("home/.claude/agents/reviewer.md", "Home review.");
      yield* roots.write(`checkout/.claude/agents/${"a".repeat(129)}.md`, "Too long a name.");

      assert.deepEqual(
        (yield* roots.list({ cwd: roots.cwd })).map(({ name, description, instructions }) => ({
          name,
          description,
          instructions,
        })),
        [
          {
            name: "code-reviewer",
            description: "Reviews diffs.",
            instructions: "Review the diff.",
          },
          { name: "plain", description: undefined, instructions: "No frontmatter." },
          { name: "reviewer", description: undefined, instructions: "Home review." },
          {
            name: "unnamed",
            description: "Use when: a Claude-style description has a colon.",
            instructions: "Body.",
          },
        ],
      );
      const error = yield* roots
        .resolve({ cwd: roots.cwd, name: "local-review" })
        .pipe(Effect.flip);
      assert.instanceOf(error, AgentDefinitions.AgentDefinitionInvalidError);
      assert.deepInclude(error, {
        name: "local-review",
        path: mismatched,
        reason: "name_mismatch",
      });
    }),
  );

  it.effect("blocks a lower-precedence file behind an invalid winner", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const roots = yield* makeRoots();
      const malformed = yield* roots.write(
        "checkout/.claude/agents/reviewer.md",
        "---\nname: [reviewer\n---\nBody.",
      );
      const unterminated = yield* roots.write(
        "checkout/.claude/agents/unterminated.md",
        "---\nname: unterminated\nmodel: opus\n\nBody.",
      );
      const empty = yield* roots.write(
        "checkout/.claude/agents/empty.md",
        "---\nname: empty\n---\n\n",
      );
      const aliasedLarge = yield* roots.write(
        "checkout/.claude/agents/large.md",
        `---\nname: reviewer\n---\n${"x".repeat(65 * 1024)}`,
      );
      const missing = yield* roots.write("shared/missing.md", "Deleted.");
      const dangling = `${roots.cwd}/.claude/agents/dangling.md`;
      yield* fileSystem.symlink(missing, dangling);
      yield* fileSystem.remove(missing);
      for (const name of ["reviewer", "unterminated", "empty", "large", "dangling"]) {
        yield* roots.write(`home/.claude/agents/${name}.md`, "Valid home copy.");
      }

      assert.deepEqual(yield* roots.list({ cwd: roots.cwd }), []);
      for (const [name, path, reason] of [
        ["reviewer", malformed, "malformed_frontmatter"],
        ["unterminated", unterminated, "malformed_frontmatter"],
        ["empty", empty, "empty_instructions"],
        ["large", aliasedLarge, "too_large"],
        ["dangling", dangling, "unreadable"],
      ] as const) {
        const error = yield* roots.resolve({ cwd: roots.cwd, name }).pipe(Effect.flip);
        assert.instanceOf(error, AgentDefinitions.AgentDefinitionInvalidError);
        assert.deepInclude(error, { name, path, reason });
      }
      assert.equal(
        (yield* roots.resolve({ cwd: undefined, name: "reviewer" })).instructions,
        "Valid home copy.",
      );
    }),
  );

  it.effect("fails a winner it cannot read", (context) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.isWindows) || (yield* HostProcess.UserId) === 0) {
        return context.skip();
      }
      const fileSystem = yield* FileSystem.FileSystem;
      const roots = yield* makeRoots();
      const locked = yield* roots.write("checkout/.claude/agents/locked.md", "Locked.");
      yield* roots.write("home/.claude/agents/locked.md", "Valid home copy.");
      yield* fileSystem.chmod(locked, 0);

      const error = yield* roots.resolve({ cwd: roots.cwd, name: "locked" }).pipe(Effect.flip);
      assert.instanceOf(error, AgentDefinitions.AgentDefinitionInvalidError);
      assert.deepInclude(error, { name: "locked", path: locked, reason: "unreadable" });
    }),
  );

  it.effect("reports a symlinked definition at its real path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const roots = yield* makeRoots();
      const target = yield* roots.write("shared/agents/poteto-agent.md", "Read ../docs first.");
      yield* fileSystem.makeDirectory(path.join(roots.cwd, ".claude/agents"), { recursive: true });
      yield* fileSystem.symlink(target, path.join(roots.cwd, ".claude/agents/poteto-agent.md"));

      assert.equal((yield* roots.resolve({ cwd: roots.cwd, name: "poteto-agent" })).path, target);
    }),
  );

  it.effect("reads only home roots without a checkout and sees edits on the next call", () =>
    Effect.gen(function* () {
      const roots = yield* makeRoots();
      yield* roots.write("checkout/.claude/agents/project-only.md", "Project.");
      yield* roots.write("home/.cursor/agents/helper.md", "First draft.");

      assert.deepEqual(
        (yield* roots.list({ cwd: undefined })).map((definition) => definition.name),
        ["helper"],
      );
      yield* roots.write("home/.cursor/agents/helper.md", "Second draft.");
      assert.equal(
        (yield* roots.resolve({ cwd: undefined, name: "helper" })).instructions,
        "Second draft.",
      );
    }),
  );
});
