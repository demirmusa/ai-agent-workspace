import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      reporter: ['text', 'json-summary'],
    },
    include: ['**/tests/**/*.test.ts'],
    globalSetup: ['control-server/tests/helpers/pty-helper-setup.ts'],
    // API/PTY tests launch real processes; bound parallel load and allow their
    // existing 10-second UI waits to finish before the outer test deadline.
    maxWorkers: 4,
    testTimeout: 15_000,
    mockReset: true,
    restoreMocks: true,
  },
});
