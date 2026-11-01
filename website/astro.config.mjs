import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://fridayai.my.id",
  // catalog/ lives one level above this package; the dev server must be allowed to read it.
  vite: { server: { fs: { allow: [".."] } } },
});
