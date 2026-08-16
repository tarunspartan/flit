import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {VitePWA} from 'vite-plugin-pwa'

// A GitHub Pages project site is served from /<repo>/, so the build has to know
// its prefix up front — every asset URL is baked in. The deploy workflow passes
// it in; dev, preview, and a custom domain all want the root and get it by
// leaving BASE_PATH unset.
const base = (process.env.BASE_PATH || '/').replace(/\/?$/, '/')

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'icon.svg'],
      manifest: {
        name: 'flit — move files between your devices',
        short_name: 'flit',
        description:
          'Move files directly between your devices. No account, no app, no cloud upload.',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0b0d10',
        theme_color: '#0b0d10',
        categories: ['utilities', 'productivity'],
        // Puts flit in the OS share sheet once installed. Only `files` is
        // declared: accepting title/text/url would offer the app for sharing a
        // link or a note, and there is nothing here that could send one.
        //
        // `action` is relative so it resolves against wherever the manifest
        // lands, which is what keeps a /<repo>/ deploy working.
        share_target: {
          action: 'share',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            files: [{name: 'files', accept: ['*/*']}]
          }
        },
        icons: [
          {src: 'icon-192.png', sizes: '192x192', type: 'image/png'},
          {src: 'icon-512.png', sizes: '512x512', type: 'image/png'},
          {src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable'},
          {src: 'icon.svg', sizes: 'any', type: 'image/svg+xml'}
        ]
      },
      workbox: {
        // The app shell only. The large install icons are deliberately left
        // out — the OS fetches those while online, and precaching them would
        // more than double the download for no offline benefit. Everything else
        // the app talks to (signaling relays, STUN) is WebSocket/UDP and never
        // passes through the service worker at all.
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // Adds the share-sheet handler to the generated worker. It registers
        // its fetch listener before Workbox sets up routing, and only ever
        // answers the POST the OS sends.
        importScripts: ['share-target.js'],
        navigateFallback: 'index.html',
        // The share POST is a navigation; the app shell must not swallow it.
        navigateFallbackDenylist: [/\/share$/],
        // A part-received file can be gigabytes; never let one near the cache.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        cleanupOutdatedCaches: true
      },
      devOptions: {
        // Keep the service worker out of the way while developing.
        enabled: false
      }
    })
  ],
  server: {
    // Phones on the same Wi-Fi need to reach the dev server by LAN IP.
    host: true,
    port: 5173
  },
  build: {
    target: 'es2022',
    sourcemap: true
  },
  worker: {
    format: 'es'
  }
})
