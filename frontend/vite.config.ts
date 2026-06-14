import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  envDir: '../',
  envPrefix: ['VITE_', 'DYNAMIC_ENVIRONMENT_ID', 'DYNAMIC_ENVIROMENT_ID'],
  plugins: [react()],
})
