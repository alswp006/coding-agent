import { describe, it, expect } from "vitest";
import { createEmptyDraft, draftFieldNames } from "../draft";
import type { DraftFormState } from "../draft";

describe("createEmptyDraft", () => {
  it("returns an object with all required fields", () => {
    const draft = createEmptyDraft();
    const keys = Object.keys(draft).sort();
    const expected = [
      "captions",
      "category",
      "highlights",
      "language",
      "photos",
      "place_name",
      "tone",
      "urls",
    ];
    expect(keys).toEqual(expected);
  });

  it("initializes every field to an empty string", () => {
    const draft = createEmptyDraft();
    for (const key of Object.keys(draft) as (keyof DraftFormState)[]) {
      expect(draft[key]).toBe("");
    }
  });

  it("returns a new object on each call", () => {
    const a = createEmptyDraft();
    const b = createEmptyDraft();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("draftFieldNames", () => {
  it("returns exactly 8 field names", () => {
    expect(draftFieldNames()).toHaveLength(8);
  });

  it("includes place_name and urls", () => {
    const names = draftFieldNames();
    expect(names).toContain("place_name");
    expect(names).toContain("urls");
  });
});
