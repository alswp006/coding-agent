# Summary
This PR implements the `normalizeInput()` utility function that trims whitespace and collapses consecutive whitespace characters into a single space. It also throws an error if the input is empty after trimming.

# How to test
1. Run the tests in `src/domain/__tests__/normalizeInput.test.ts` using Vitest.
2. Ensure all tests pass.

# Risk & rollback
Risk: If the function does not handle edge cases correctly, it may lead to unexpected behavior in other parts of the application.
Rollback: Revert the changes in `normalizeInput.ts` if any issues arise.

# Notes
- The function is designed to handle strings and will throw an error for empty inputs.
- Additional tests will be added in the corresponding test file.
