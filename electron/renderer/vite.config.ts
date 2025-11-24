import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../../dist/electron/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        taskbar: path.resolve(__dirname, 'taskbar.html'),
      },
    },
  },
  server: {
    port: 5173,
  },
})
