import { defineConfig } from 'vite';

// Multipage build; the HTML entry points live at the frontend root.
// The public page and the owner dashboard get fleshed out in tasks 14 and 15.
export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: new URL('./index.html', import.meta.url).pathname,
      },
    },
  },
});
