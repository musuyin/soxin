import { defineConfig } from 'vite'

export default defineConfig({
  root: 'dashboard',
  build: {
    outDir: '../dist/dashboard',
    emptyOutDir: true,
    rolldownOptions: {
      onwarn(warning, warn) {
        // The dashboard renders entirely in the browser.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return
        warn(warning)
      },
    },
  },
})
