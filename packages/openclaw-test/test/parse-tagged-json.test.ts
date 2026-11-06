import { describe, expect, it } from "vitest";
import { extractTaggedBlock } from "../src/parse-tagged-json.js";

describe("extractTaggedBlock", () => {
  it("returns the tag content with surrounding prose", () => {
    const raw = 'thinking ...\n<result-json>{"a":1}</result-json>\ntrailing.';
    expect(extractTaggedBlock(raw, "result-json")).toBe('{"a":1}');
  });

  it("preserves newlines and embedded JSON inside the tag", () => {
    const raw = '<result-json> \t\n{\n  "a": 1\n}\n\t </result-json>';
    expect(extractTaggedBlock(raw, "result-json")).toBe('{\n  "a": 1\n}');
  });

  it("throws when the opening tag is missing", () => {
    expect(() => extractTaggedBlock("nothing here", "result-json")).toThrow();
  });

  it("throws when the closing tag is missing", () => {
    expect(() => extractTaggedBlock("<result-json>oops", "result-json")).toThrow();
  });

  it("returns only the first occurrence when the tag appears twice", () => {
    const raw = "<result-json>first</result-json> blah <result-json>second</result-json>";
    expect(extractTaggedBlock(raw, "result-json")).toBe("first");
  });
});
