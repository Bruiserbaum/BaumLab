import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Build stamp for the UI bundle — compared with the API's to spot a stale cached page after a redeploy
  define: {
    __UI_BUILT__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: {
      '/api': 'http://api:8000',
    },
  },
})
