// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// An existing Starlight site with hand-made German translations and no MoggingCMS configuration.
export default defineConfig({
  integrations: [
    starlight({
      title: "Adopter Docs",
      locales: {
        root: { label: "English", lang: "en" },
        de: { label: "Deutsch", lang: "de" },
      },
      sidebar: [
        { label: "Setup", slug: "guides/setup" },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
      ],
    }),
  ],
});
