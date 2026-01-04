# Summary
Implement `normalizeInput()` utility that trims and normalizes whitespace in a string.

# How to test
1. Run `pnpm test` to execute the tests.
2. Check the functionality by calling `normalizeInput()` with various string inputs.

# Risk & rollback
- Risk: If the function does not handle edge cases correctly, it may throw unexpected errors.
- Rollback: Revert the changes in `normalizeInput.ts` if issues arise.

# Notes
- The utility function ensures that all whitespace is normalized and throws an error for empty strings.
- Tests will be added in the next commit to validate the functionality.
