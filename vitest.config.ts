import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // Pins Vite's project root explicitly. This backend lives nested inside
  // the apex-web (Next.js) project folder — without an explicit root, Vite's
  // config/PostCSS resolution walks UP the directory tree, finds apex-web's
  // postcss.config.js (which references `tailwindcss`), and tries to
  // require it from this project's node_modules, where it doesn't exist:
  // "Failed to load PostCSS config ... Cannot find module 'tailwindcss'".
  // This is a pure Express/Prisma backend with zero CSS, so we also
  // explicitly disable CSS processing below as a second guard.
  //
  // Neither of those alone stopped it, though: Vite's CSS plugin calls
  // postcss-load-config unconditionally during its own startup (it's a
  // filesystem search that walks up parent directories looking for a
  // config), regardless of `root` or `test.css`. Providing an explicit,
  // empty `css.postcss` object here is what actually short-circuits that
  // search — Vite only auto-searches when this is left undefined.
  root: __dirname,
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    // Run test files sequentially to avoid parallel DB cleanup conflicts
    fileParallelism: false,
    css: false,
    // Some pool-settlement tests do a real `sleep()` to let a pool's endsAt
    // pass, then chain several real DB round-trips (create/join/upload/
    // settle/lookup). Against a remote Postgres (e.g. Neon) the added network
    // latency per round-trip can push total test time past Vitest's default
    // 5000ms, even though nothing is actually hung. 20s gives real headroom
    // without meaningfully weakening the timeout as a hang detector.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/types/**'],
    },
  },
});
