export type DraftFormState = {
  place_name: string;
  photos: string;
  captions: string;
  highlights: string;
  category: string;
  tone: string;
  language: string;
  urls: string;
};

export const DRAFT_FORM_FIELDS = [
  "place_name",
  "photos",
  "captions",
  "highlights",
  "category",
  "tone",
  "language",
  "urls",
] as const;
