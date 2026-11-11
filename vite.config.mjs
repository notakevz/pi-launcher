import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// Bundle the actual installed production graph's complete license notices.
function frontendLicenses() {
  return {
    name: 'frontend-license-notices',
    generateBundle() {
      const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
      const notices = ['Pi Launcher frontend dependency licenses\nGenerated from package-lock.json; preserve with the bundled frontend.\n'];
      for (const [location, entry] of Object.entries(lock.packages).sort()) {
        if (!location || entry.dev || !location.startsWith('node_modules/')) continue;
        const folder = path.join(root, location);
        const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
        const licenses = fs.readdirSync(folder).filter(name => /^licen[cs]e(?:[.-]|$)/i.test(name));
        if (!licenses.length) throw new Error(`Missing license notice: ${pkg.name}`);
        notices.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version} (${pkg.license || entry.license || 'see notice'})\n`);
        for (const license of licenses.sort()) notices.push(fs.readFileSync(path.join(folder, license), 'utf8'));
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_FRONTEND_LICENSES.txt', source: notices.join('\n') });
    },
  };
}

export default defineConfig({
  root: path.join(root, 'ui'),
  base: './',
  plugins: [vue(), frontendLicenses()],
  build: {
    outDir: path.join(root, '.build/ui'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: { main: path.join(root, 'ui/index.html'), tray: path.join(root, 'ui/tray.html') } },
  },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
