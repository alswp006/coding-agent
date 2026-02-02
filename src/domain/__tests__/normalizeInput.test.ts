import { describe, it, expect } from "vitest";
import { normalizeInput } from "../normalizeInput";

describe("normalizeInput", () => {
  it("trims and collapses spaces", () => {
    expect(normalizeInput(" hello   world ")).toBe("hello world");
  });

  it("collapses tabs/newlines into spaces", () => {
    expect(normalizeInput("hello\t\tworld\nnext")).toBe("hello world next");
  });

  it("keeps single spaces", () => {
    expect(normalizeInput("a b c")).toBe("a b c");
  });

  it("throws on empty after trim", () => {
    expect(() => normalizeInput("   ")).toThrow("Input is empty");
  });
});
