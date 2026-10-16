import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// relative base so the build works under a GitHub Pages project path,
// output goes to docs/ because Pages serves from there
export default defineConfig({
	base: './',
	plugins: [react()],
	build: { outDir: 'docs', emptyOutDir: true, assetsInlineLimit: 0 },
});
