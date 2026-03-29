import { describe, it, expect } from "vitest";
import { DRAFT_FORM_FIELDS } from "../draftForm";
import type { DraftFormState } from "../draftForm";

describe("DraftFormState", () => {
  it("DRAFT_FORM_FIELDS contains all 8 required field names", () => {
    expect(DRAFT_FORM_FIELDS).toEqual([
      "place_name",
      "photos",
      "captions",
      "highlights",
      "category",
      "tone",
      "language",
      "urls",
    ]);
  });

  it("a DraftFormState object can hold all field values", () => {
    const draft: DraftFormState = {
      place_name: "My Place",
      photos: "https://example.com/a.jpg",
      captions: "Caption 1",
      highlights: "Great view",
      category: "cafe",
      tone: "friendly",
      language: "en",
      urls: "https://example.com",
    };

    expect(draft.place_name).toBe("My Place");
    expect(draft.category).toBe("cafe");
    expect(Object.keys(draft)).toHaveLength(8);
    expect(Object.keys(draft).sort()).toEqual([...DRAFT_FORM_FIELDS].sort());
  });
});
