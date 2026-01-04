export function normalizeInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("Input is empty");
  }
  return trimmed.replace(/\s+/g, " ");
}
