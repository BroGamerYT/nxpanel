import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Lokales Konto der Standalone-Oberflaeche: festes Passwort nur fuer Tests.
    env: {
      NEXUSCORE_ADMIN_USER: 'admin',
      NEXUSCORE_ADMIN_PASSWORD: 'nur-fuer-tests-0815',
    },
    testTimeout: 20000,
  },
});
