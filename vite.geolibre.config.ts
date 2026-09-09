import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import packageMetadata from "./package.json" with { type: "json" };
import pluginManifest from "./geolibre-plugin/plugin.json" with {
  type: "json",
};

if (pluginManifest.version !== packageMetadata.version) {
  throw new Error(
    `Plugin version ${pluginManifest.version} does not match package version ${packageMetadata.version}.`,
  );
}

export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("src/geolibre.ts", import.meta.url)),
      formats: ["es"],
      fileName: "index",
    },
    outDir: "geolibre-plugin/dist",
    cssCodeSplit: false,
    minify: false,
    rollupOptions: {
      output: {
        assetFileNames: "style.css",
      },
    },
  },
});
