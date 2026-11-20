import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Vite + Vitest configuration for the SurgeonPulse dashboard.
 *
 * - `base: './'` makes every asset URL relative, so the production build can be
 *   served from any static host or sub-path (university web space, intranet
 *   share, GitHub Pages, …) without rebuilding.
 * - `build.target` follows the "Baseline widely available" browser set, which
 *   covers current Chrome/Edge (Windows, macOS, Linux, ChromeOS, Android),
 *   Firefox, and Safari on macOS and iPadOS 16+.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: ['es2022', 'chrome111', 'edge111', 'firefox114', 'safari16'],
    // Recharts + the core analytics library form one ~600 kB chunk; that is expected.
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
