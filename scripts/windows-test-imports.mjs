// Build-time ESM compatibility only. Keep CommonJS resolution untouched so Jiti's
// TypeScript path aliases and React test shims continue working normally.
import { register } from "node:module";
register("./windows-test-loader.mjs", import.meta.url);
