import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron'

export default defineConfig({
  base: './',
  server: {
    port: 5174
  },
  plugins: [
    electron([
      {
        entry: 'electron/main.ts'
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        }
      }
    ])
  ]
})
