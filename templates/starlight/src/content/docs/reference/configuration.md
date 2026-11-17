---
title: Configuration
description: A sample reference page. Replace this page with yours.
---

This is a sample reference page. Replace this page with yours.

Two files describe the languages of the site, and they must agree:

- `astro.config.mjs` lists the languages Starlight serves, under `locales`.
- `mogging.config.ts` lists the languages Mogging translates into, under `localeDirs`.

To add a language, add it to both files. Mogging skips, with a warning, a language folder that only
`astro.config.mjs` knows about.
