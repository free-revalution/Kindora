import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    // Phase A — jsdom has no `crypto.subtle`; the setup file installs
    // Node's WebCrypto so the signing / ECDH / AES-GCM paths can be
    // exercised for real.
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
