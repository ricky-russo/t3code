import { parse as parseYaml } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type MarkdownFrontmatter =
  | { readonly kind: "none"; readonly body: string }
  | { readonly kind: "malformed"; readonly body: string }
  | {
      readonly kind: "parsed";
      readonly fields: Readonly<Record<string, unknown>>;
      readonly body: string;
    };

/** Claude Code accepts unquoted values containing ": "; quote them without disturbing comments or structure. */
function quoteColonScalars(source: string): string {
  return source.replace(/^([\w-]+:[ \t]*)([^\r\n]*)/gm, (line, prefix: string, value: string) => {
    const scalar = value.split(/[ \t]+#/)[0] ?? "";
    if (!/:[ \t]/.test(scalar) || /^(?:["'[\]{}|>&*!#%@`]|[-?:](?:[ \t]|$))/.test(scalar)) {
      return line;
    }
    return `${prefix}${JSON.stringify(scalar)}${value.slice(scalar.length)}`;
  });
}

function parseYamlMapping(source: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parseYaml(source);
    if (parsed === null || parsed === undefined) return {};
    return typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Only a closed `---` fence is frontmatter; one that is not a YAML mapping is malformed. */
export function splitMarkdownFrontmatter(contents: string): MarkdownFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (match === null) return { kind: "none", body: contents };
  const source = match[1] ?? "";
  const body = contents.slice(match[0].length);
  const fields = parseYamlMapping(source) ?? parseYamlMapping(quoteColonScalars(source));
  return fields === undefined ? { kind: "malformed", body } : { kind: "parsed", fields, body };
}
