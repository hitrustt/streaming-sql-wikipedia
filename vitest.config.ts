import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default suite must be hermetic: it runs in CI and gates deployment,
    // so a Wikimedia outage or a slow network can never be the reason a build
    // fails. The live integration test is run explicitly instead:
    //   npx vitest run src/engine/live.integration.test.ts
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
  },
});
