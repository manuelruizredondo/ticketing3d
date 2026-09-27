import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // three.js ocupa ~520 kB por sí solo: es el mínimo razonable del chunk 3D
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // three va aparte: no cambia entre despliegues y queda en caché
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
