import { describe, expect, it } from "vitest";
import { type CommentSyntax, commentSyntaxForExtension, stripComments } from "../../src/engine";

/** The syntax for an extension the table must know, failing the test if absent. */
const syntax = (ext: string): CommentSyntax => {
  const found = commentSyntaxForExtension(ext);
  if (!found) throw new Error(`expected a comment syntax for ${ext}`);
  return found;
};

const ts = syntax("ts");
const py = syntax("py");
const css = syntax("css");
const scss = syntax("scss");
const html = syntax("html");
const jsonc = syntax("jsonc");

describe("commentSyntaxForExtension", () => {
  it("covers the // and block comment languages", () => {
    expect(commentSyntaxForExtension("ts")).toEqual({
      line: ["//"],
      block: [["/*", "*/"]],
    });
    expect(commentSyntaxForExtension("jsonc")).toEqual({
      line: ["//"],
      block: [["/*", "*/"]],
    });
  });

  it("covers the # family", () => {
    expect(commentSyntaxForExtension("py")).toEqual({ line: ["#"] });
    expect(commentSyntaxForExtension("toml")).toEqual({ line: ["#"] });
  });

  it("gives plain css block comments only, no //", () => {
    expect(commentSyntaxForExtension("css")).toEqual({ block: [["/*", "*/"]] });
    expect(commentSyntaxForExtension("scss")).toEqual({
      line: ["//"],
      block: [["/*", "*/"]],
    });
  });

  it("gives plain json no comments at all", () => {
    expect(commentSyntaxForExtension("json")).toBeNull();
  });

  it("returns null for an unknown extension", () => {
    expect(commentSyntaxForExtension("xyz")).toBeNull();
  });

  it("is case-insensitive and tolerates a leading dot", () => {
    expect(commentSyntaxForExtension("TS")).toEqual(commentSyntaxForExtension("ts"));
    expect(commentSyntaxForExtension(".py")).toEqual(commentSyntaxForExtension("py"));
  });
});

describe("stripComments", () => {
  it("strips a full-line // comment", () => {
    expect(stripComments("// note", ts)).toBe("");
    expect(stripComments("  // indented note", ts)).toBe("");
  });

  it("strips a trailing // comment", () => {
    expect(stripComments("const x = 1; // note", ts)).toBe("const x = 1;");
  });

  it("strips a # comment", () => {
    expect(stripComments("x = 1  # note", py)).toBe("x = 1");
  });

  it("removes a same-line block comment", () => {
    expect(stripComments("const x = 1; /* note */", ts)).toBe("const x = 1;");
    // A block removed from the middle leaves the surrounding whitespace as-is.
    expect(stripComments("const x = /* two */ 2;", ts)).toBe("const x =  2;");
  });

  it("removes a same-line HTML comment", () => {
    expect(stripComments("<p>hi</p> <!-- note -->", html)).toBe("<p>hi</p>");
  });

  it("leaves a line without a comment unchanged", () => {
    expect(stripComments("const x = 1;", ts)).toBe("const x = 1;");
    expect(stripComments("color: red; // note", css)).toBe("color: red; // note");
    expect(stripComments('{"a": 1} // note', null)).toBe('{"a": 1} // note');
  });

  it("does not strip a marker inside a string literal", () => {
    expect(stripComments('const u = "https://example.com"; // note', ts)).toBe(
      'const u = "https://example.com";',
    );
    expect(stripComments('const s = "a # b";', py)).toBe('const s = "a # b";');
    expect(stripComments("const s = `a // b`;", ts)).toBe("const s = `a // b`;");
  });

  it("handles an escaped quote inside a string literal", () => {
    expect(stripComments("const s = 'it\\'s // fine'; // note", ts)).toBe(
      "const s = 'it\\'s // fine';",
    );
  });

  it("treats a whole template literal as one string, including its expressions", () => {
    // Known v1 limitation: a marker inside a ${...} expression is code, but the
    // scan cannot tell it apart from the literal text around it.
    expect(stripComments(`const s = \`x \${f(1 // 2)} y\`;`, ts)).toBe(
      `const s = \`x \${f(1 // 2)} y\`;`,
    );
  });

  it("leaves a multi-line block comment untouched", () => {
    expect(stripComments("/* start of a block", ts)).toBe("/* start of a block");
    expect(stripComments("old text", ts)).toBe("old text");
    expect(stripComments("end of a block */", ts)).toBe("end of a block */");
  });

  it("strips a // comment in jsonc but not in plain css", () => {
    expect(stripComments('{"a": 1} // note', jsonc)).toBe('{"a": 1}');
    expect(stripComments("// note", scss)).toBe("");
  });
});
