// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import moggingStarlight from "@mogging/starlight";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Mogging Docs",
      // These locales must match `localeDirs` in mogging.config.ts. To add a language, change both files.
      locales: {
        root: { label: "English", lang: "en" },
        de: { label: "Deutsch", lang: "de" },
        "zh-cn": { label: "简体中文", lang: "zh-CN" },
      },
      sidebar: [
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
    }),
    // A no-op integration: it reads nothing and prints nothing. It keeps the package installed where the site builds.
    moggingStarlight(),
  ],
});
