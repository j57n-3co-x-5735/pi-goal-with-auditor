import { describe, it, expect } from "vitest";
import { escapeXML, continuationPrompt } from "../src/prompts";

describe("escapeXML", () => {
  it("escapes ampersands", () => {
    expect(escapeXML("a & b")).toBe("a &amp; b");
  });

  it("escapes less-than signs", () => {
    expect(escapeXML("a < b")).toBe("a &lt; b");
  });

  it("escapes greater-than signs", () => {
    expect(escapeXML("a > b")).toBe("a &gt; b");
  });

  it("escapes all special characters in combination", () => {
    expect(escapeXML("<objective> & goal</objective>")).toBe(
      "&lt;objective&gt; &amp; goal&lt;/objective&gt;",
    );
  });

  it("returns the same string when there is nothing to escape", () => {
    expect(escapeXML("hello world")).toBe("hello world");
  });

  it("returns empty string for empty input", () => {
    expect(escapeXML("")).toBe("");
  });

  // Only & < > were escaped -- NUL, other C0 controls, and
  // bidi override/isolate characters passed through raw. Left in, any of these could
  // truncate, reorder, or visually obscure the prompt text around them (e.g. a bidi override
  // placed just before a verdict instruction). Built from String.fromCodePoint rather than
  // literal characters in this file so nothing invisible sits in the test source either.
  describe("control character stripping", () => {
    it("strips NUL and other C0 control characters", () => {
      const nul = String.fromCodePoint(0x0000);
      const escape = String.fromCodePoint(0x001b);
      expect(escapeXML(`hello${nul}world${escape}end`)).toBe("helloworldend");
    });

    it("strips DEL", () => {
      const del = String.fromCodePoint(0x007f);
      expect(escapeXML(`hello${del}world`)).toBe("helloworld");
    });

    it("strips zero-width spaces and joiners", () => {
      const zeroWidthSpace = String.fromCodePoint(0x200b);
      const zeroWidthJoiner = String.fromCodePoint(0x200d);
      expect(escapeXML(`hello${zeroWidthSpace}world${zeroWidthJoiner}end`)).toBe("helloworldend");
    });

    it("strips bidi override, embedding, and isolate characters", () => {
      const rtlOverride = String.fromCodePoint(0x202e);
      const leftToRightIsolate = String.fromCodePoint(0x2066);
      expect(escapeXML(`hello${rtlOverride}world${leftToRightIsolate}end`)).toBe("helloworldend");
    });

    it("preserves tab, LF, and CR", () => {
      const withWhitespace = "a\tb\nc\rd";
      expect(escapeXML(withWhitespace)).toBe(withWhitespace);
    });

    it("still escapes & < > after stripping control characters", () => {
      const nul = String.fromCodePoint(0x0000);
      expect(escapeXML(`<tag>${nul}& more`)).toBe("&lt;tag&gt;&amp; more");
    });
  });
});

describe("continuationPrompt", () => {
  it("wraps the objective in untrusted_objective tags", () => {
    const prompt = continuationPrompt("write tests");
    expect(prompt).toContain("<untrusted_objective>");
    expect(prompt).toContain("</untrusted_objective>");
  });

  it("includes the objective text inside the tags", () => {
    const prompt = continuationPrompt("write tests");
    expect(prompt).toContain("<untrusted_objective>\nwrite tests\n</untrusted_objective>");
  });

  it("escapes XML special characters in the objective", () => {
    const prompt = continuationPrompt("install foo & bar <baz>");
    expect(prompt).toContain("install foo &amp; bar &lt;baz&gt;");
  });

  it('includes the phrase "completion audit"', () => {
    const prompt = continuationPrompt("do stuff");
    expect(prompt).toContain("completion audit");
  });

  it('includes the phrase "Continue working toward the active thread goal"', () => {
    const prompt = continuationPrompt("do stuff");
    expect(prompt).toContain("Continue working toward the active thread goal.");
  });

  it('includes the warning not to mark complete when stopping work', () => {
    const prompt = continuationPrompt("do stuff");
    expect(prompt).toContain(
      "Do not mark a goal complete merely because the budget is nearly exhausted or because you are stopping work",
    );
  });

  it("does not include the empty-turn nudge by default", () => {
    const prompt = continuationPrompt("do stuff");
    expect(prompt).not.toContain("made no tool calls");
  });

  // The weak-model fix: after a text-only cycle, the continuation prompt is prefixed with an
  // explicit instruction to take a real action instead of asking or only describing.
  it("prepends an action nudge when opts.nudge is set", () => {
    const prompt = continuationPrompt("do stuff", { nudge: true });
    expect(prompt).toContain("made no tool calls");
    expect(prompt).toContain("Take one concrete action now");
    // The nudge is first so a small model reads it before anything else.
    expect(prompt.indexOf("made no tool calls")).toBeLessThan(
      prompt.indexOf("Continue working toward the active thread goal."),
    );
    // The normal continuation content is still present.
    expect(prompt).toContain("<untrusted_objective>\ndo stuff\n</untrusted_objective>");
  });
});
