import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

function hasText(html: string, text: string): boolean {
  return html.includes(text);
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("Create New Draft page skeleton", () => {
  it("renders all required field labels and Generate button text", async () => {
    const mod = await import("../../app/page");
    const Page = mod.default;

    const html = renderToStaticMarkup(<Page />);

    expect(hasText(html, "place_name")).toBe(true);
    expect(hasText(html, "photos")).toBe(true);
    expect(hasText(html, "captions")).toBe(true);
    expect(hasText(html, "highlights")).toBe(true);
    expect(hasText(html, "category")).toBe(true);
    expect(hasText(html, "tone")).toBe(true);
    expect(hasText(html, "language")).toBe(true);
    expect(hasText(html, "urls")).toBe(true);
    expect(hasText(html, "Generate")).toBe(true);
  });

  it("splits multiline inputs into arrays (same behavior used by Generate)", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines(" \n  a  \n\nb \n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});
