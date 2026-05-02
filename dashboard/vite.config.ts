import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Don't inject the SW registration script in dev — avoids stale-cache confusion
      devOptions: {
        enabled: false,
      },
      includeAssets: [
        'favicon.ico',
        'favicon.png',
        'apple-touch-icon-180x180.png',
        'octoally-icon.png',
      ],
      manifest: {
        name: 'OctoAlly',
        short_name: 'OctoAlly',
        description: 'AI coding agent dashboard — manage Claude Code sessions and projects from your browser.',
        theme_color: '#ef4444',
        background_color: '#0f1117',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '/',
        start_url: '/',
        categories: ['developer', 'productivity', 'utilities'],
        icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Cache the app shell (HTML, JS, CSS, fonts).
        // The main bundle includes CodeMirror + xterm.js so it legitimately
        // exceeds Workbox's default 2 MiB limit — raise it to 4 MiB.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // For API calls: always go network-first so live data is fresh.
        // Falls back to cache only when offline.
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60, // 1 hour
              },
              networkTimeoutSeconds: 5,
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 42011,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:42010',
        ws: true,
      },
    },
  },
});
