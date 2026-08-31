export const MAX_THREAD_PREVIEW_CHARACTERS = 320;

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/** Bound by visible grapheme so emoji sequences and combining marks stay intact. */
export function boundThreadPreview(preview: string): string {
  if (preview.length <= MAX_THREAD_PREVIEW_CHARACTERS) return preview;
  const characters = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(preview), (part) => part.segment)
    : Array.from(preview);
  return characters.length <= MAX_THREAD_PREVIEW_CHARACTERS
    ? preview
    : characters.slice(0, MAX_THREAD_PREVIEW_CHARACTERS).join("");
}
