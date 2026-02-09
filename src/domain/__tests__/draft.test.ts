import { describe, it, expect } from "vitest";
import { DRAFT_FIELD_NAMES } from "../draft";
import type { DraftFormState } from "../draft";

describe("DraftFormState", () => {
  it("DRAFT_FIELD_NAMES contains all required fields", () => {
    const required = [
      "place_name",
      "photos",
      "captions",
      "highlights",
      "category",
      "tone",
      "language",
      "urls",
    ];
    for (const field of required) {
      expect(DRAFT_FIELD_NAMES).toContain(field);
    }
  });

  it("DRAFT_FIELD_NAMES has exactly 8 fields", () => {
    expect(DRAFT_FIELD_NAMES.length).toBe(8);
  });

  it("DraftFormState type allows string values for all fields", () => {
    const state: DraftFormState = {
      place_name: "x",
      photos: "y",
      captions: "z",
      highlights: "a",
      category: "b",
      tone: "c",
      language: "d",
      urls: "e",
    };
    expect(state.place_name).toBe("x");
    expect(state.urls).toBe("e");
  });
});
