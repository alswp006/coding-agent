"use client";

import { useId, useState } from "react";
import type { DraftFormState } from "@/src/domain/draftForm";

export default function NewDraftPage() {
  const headingId = useId();

  const [placeName, setPlaceName] = useState("");
  const [photos, setPhotos] = useState("");
  const [captions, setCaptions] = useState("");
  const [highlights, setHighlights] = useState("");
  const [category, setCategory] = useState("");
  const [tone, setTone] = useState("");
  const [language, setLanguage] = useState("");
  const [urls, setUrls] = useState("");

  function handleGenerate(): void {
    const draft: DraftFormState = {
      place_name: placeName,
      photos,
      captions,
      highlights,
      category,
      tone,
      language,
      urls,
    };

    // eslint-disable-next-line no-console
    console.log("draft.generate.clicked", draft);
  }

  return (
    <main className="mx-auto w-full max-w-2xl p-6">
      <h1 id={headingId} className="text-2xl font-semibold">
        Create New Draft
      </h1>

      <form
        className="mt-6 space-y-6"
        aria-labelledby={headingId}
        onSubmit={(e) => {
          e.preventDefault();
          handleGenerate();
        }}
      >
        <div className="space-y-2">
          <label htmlFor="place_name" className="block text-sm font-medium">
            place_name
          </label>
          <input
            id="place_name"
            name="place_name"
            value={placeName}
            onChange={(e) => setPlaceName(e.target.value)}
            className="w-full rounded-md border px-3 py-2"
            placeholder="e.g., Blue Bottle Coffee"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="photos" className="block text-sm font-medium">
            photos
          </label>
          <textarea
            id="photos"
            name="photos"
            value={photos}
            onChange={(e) => setPhotos(e.target.value)}
            className="w-full rounded-md border px-3 py-2"
            placeholder="Paste photo URLs or notes (one per line)"
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="captions" className="block text-sm font-medium">
            captions
          </label>
          <textarea
            id="captions"
            name="captions"
            value={captions}
            onChange={(e) => setCaptions(e.target.value)}
            className="w-full rounded-md border px-3 py-2"
            placeholder="Optional caption ideas"
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="highlights" className="block text-sm font-medium">
            highlights
          </label>
          <textarea
            id="highlights"
            name="highlights"
            value={highlights}
            onChange={(e) => setHighlights(e.target.value)}
            className="w-full rounded-md border px-3 py-2"
            placeholder="Key highlights / bullets"
            rows={3}
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="category" className="block text-sm font-medium">
            category
          </label>
          <input
            id="category"
            name="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-md border px-3 py-2"
            placeholder="e.g., cafe, restaurant, museum"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="tone" className="block text-sm font-medium">
            tone
          </label>
          <input
            id="tone"
            name="tone"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className="w-full rounded-md border px-3 py-2"
            placeholder="e.g., friendly, witty, informative"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="language" className="block text-sm font-medium">
            language
          </label>
          <input
            id="language"
            name="language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-md border px-3 py-2"
            placeholder="e.g., en, ko, ja"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="urls" className="block text-sm font-medium">
            urls
          </label>
          <textarea
            id="urls"
            name="urls"
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            className="w-full rounded-md border px-3 py-2"
            placeholder="Reference URLs (one per line)"
            rows={3}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white"
          >
            Generate
          </button>
          <p className="text-sm text-gray-600">
            No API call is made yet; this only logs current form state.
          </p>
        </div>
      </form>
    </main>
  );
}
