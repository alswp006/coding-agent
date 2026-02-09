"use client";

import { useState } from "react";
import {
  createEmptyDraft,
  draftFieldNames,
  type DraftFormState,
} from "@/src/domain/draft";

const FIELD_LABELS: Record<keyof DraftFormState, string> = {
  place_name: "Place Name",
  photos: "Photos",
  captions: "Captions",
  highlights: "Highlights",
  category: "Category",
  tone: "Tone",
  language: "Language",
  urls: "URLs",
};

export default function NewDraftPage() {
  const [form, setForm] = useState<DraftFormState>(createEmptyDraft);

  function handleChange(field: keyof DraftFormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function handleGenerate() {
    // Read current form state — no network call is made.
    const snapshot: DraftFormState = { ...form };
    // eslint-disable-next-line no-console
    console.log("[Generate] draft state:", snapshot);
  }

  return (
    <main style={{ maxWidth: 600, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1>Create New Draft</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleGenerate();
        }}
      >
        {draftFieldNames().map((field) => {
          const isMultiline =
            field === "captions" || field === "highlights" || field === "urls";

          return (
            <div key={field} style={{ marginBottom: "1rem" }}>
              <label
                htmlFor={field}
                style={{ display: "block", marginBottom: 4 }}
              >
                {FIELD_LABELS[field]}
              </label>
              {isMultiline ? (
                <textarea
                  id={field}
                  name={field}
                  rows={3}
                  value={form[field]}
                  onChange={(e) => handleChange(field, e.target.value)}
                  style={{ width: "100%" }}
                />
              ) : (
                <input
                  id={field}
                  name={field}
                  type="text"
                  value={form[field]}
                  onChange={(e) => handleChange(field, e.target.value)}
                  style={{ width: "100%" }}
                />
              )}
            </div>
          );
        })}

        <button type="submit">Generate</button>
      </form>
    </main>
  );
}
