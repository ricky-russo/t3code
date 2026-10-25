import { describe, expect, it } from "vite-plus/test";
import { splitMarkdownFrontmatter } from "./markdownFrontmatter.ts";

describe("splitMarkdownFrontmatter", () => {
  it("parses a closed fence and keeps the body after it", () => {
    expect(
      splitMarkdownFrontmatter("---\r\nname: review\r\ntools: [Read]\r\n---\r\n\r\n# Review\n"),
    ).toEqual({
      kind: "parsed",
      fields: { name: "review", tools: ["Read"] },
      body: "\r\n# Review\n",
    });
    expect(splitMarkdownFrontmatter("---\n\n---\nBody.")).toEqual({
      kind: "parsed",
      fields: {},
      body: "Body.",
    });
  });

  it("quotes Claude-style values that contain a colon, and keeps their comments", () => {
    expect(
      splitMarkdownFrontmatter(
        "---\ndescription: Use when: a review is due # not part of it\nlabel: 'quoted: kept'\n---",
      ),
    ).toEqual({
      kind: "parsed",
      fields: { description: "Use when: a review is due", label: "quoted: kept" },
      body: "",
    });
  });

  it("reports no frontmatter without a closed fence, and malformed frontmatter without a mapping", () => {
    expect(splitMarkdownFrontmatter("# Title\n---\nname: x\n---\n")).toEqual({
      kind: "none",
      body: "# Title\n---\nname: x\n---\n",
    });
    expect(splitMarkdownFrontmatter("---\nname: x\nBody.")).toEqual({
      kind: "none",
      body: "---\nname: x\nBody.",
    });
    for (const source of ["name: [x", "- a\n- b", "just text"]) {
      expect(splitMarkdownFrontmatter(`---\n${source}\n---\nBody.`)).toEqual({
        kind: "malformed",
        body: "Body.",
      });
    }
  });
});
