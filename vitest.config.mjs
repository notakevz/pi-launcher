import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['ui/**/*.test.js'],
    maxWorkers: 1,
    restoreMocks: true,
  },
});
