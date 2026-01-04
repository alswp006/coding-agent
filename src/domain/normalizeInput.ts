export function normalizeInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Input is empty");
  }
  return trimmed.replace(/\s+/g, " ");
}
