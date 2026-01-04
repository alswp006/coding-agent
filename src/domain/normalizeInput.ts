export function normalizeInput(input: string): string {
  const normalized = input.trim().replace(/\s+/g, " ");
  if (normalized === "") {
    throw new Error("Input is empty");
  }
  return normalized;
}

// Example usage
// console.log(normalizeInput("  hello   world  ")); // "hello world"
