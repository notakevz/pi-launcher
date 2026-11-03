import { pathToFileURL } from "node:url";

export function resolve(specifier, context, nextResolve) {
  // Upstream hook tests use import(fileURLToPath(...)); Windows needs file: URLs.
  return nextResolve(/^[A-Za-z]:[\\/]/.test(specifier) ? pathToFileURL(specifier).href : specifier, context);
}
