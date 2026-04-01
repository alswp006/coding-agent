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

export const DRAFT_FIELD_NAMES: ReadonlyArray<keyof DraftFormState> = [
  "place_name",
  "photos",
  "captions",
  "highlights",
  "category",
  "tone",
  "language",
  "urls",
];
