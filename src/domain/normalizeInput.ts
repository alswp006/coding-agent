export function normalizeInput(input: string): string {
  const trimmed = input.trim();
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed === "") {
    throw new Error("Input is empty");
  }
  return collapsed;
}
