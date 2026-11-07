import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Die Datenbanktests teilen sich eine Datenbank und raeumen in
    // beforeEach auf - parallel wuerden sie sich gegenseitig stoeren.
    fileParallelism: false,
    maxConcurrency: 1,
    include: ['tests/**/*.test.ts'],
    // Immer eigene Testdatenbank (<name>_test) und Redis-DB 15 -
    // nie die Datenbank des laufenden Panels. Siehe tests/setup/test-db.ts.
    globalSetup: ['tests/setup/global.ts'],
    setupFiles: ['tests/setup/env.ts'],
  },
});
