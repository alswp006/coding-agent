export interface DraftFormState {
  place_name: string;
  photos: string;
  captions: string;
  highlights: string;
  category: string;
  tone: string;
  language: string;
  urls: string;
}

export function createEmptyDraft(): DraftFormState {
  return {
    place_name: "",
    photos: "",
    captions: "",
    highlights: "",
    category: "",
    tone: "",
    language: "",
    urls: "",
  };
}

export function draftFieldNames(): readonly (keyof DraftFormState)[] {
  return [
    "place_name",
    "photos",
    "captions",
    "highlights",
    "category",
    "tone",
    "language",
    "urls",
  ] as const;
}
