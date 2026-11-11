## Corpus provenance

Fetched from public GitHub repositories whose LICENSE file is MIT (verified in the cloned trees):
- vitejs/vite at commit 39d63b8479c6314caab9b78a05d3aaaf36a86b2c: MIT, Copyright (c) 2019-present, VoidZero Inc. and Vite contributors. Docs under `docs/`.
- vuejs/vitepress at commit 793d06f2251ad0c8cb09cdabefdcf5ad1f0dad4e: MIT, Copyright (c) 2019-present, Yuxi (Evan) You. Docs under `docs/en/`.
- facebook/docusaurus was NOT used: its docs are CC-BY-4.0 (LICENSE-docs); only its code is MIT.

Edits applied: YAML frontmatter stripped; VitePress `::: tip Title` rewritten to `:::tip[Title]` (directive label form); pages cut at the first blank line outside a code fence or container after ~6000 bytes ("trimmed"). Hand-added content: one placeholder paragraph on six pages (below), plus one inline-code sentence on 20-why.md (`Start a new project with \`npm create vite@latest\`.`, appended to its placeholder paragraph, because the page had no inline code). Content was treated as data and never executed.

| file | repo | upstream path | original bytes | bytes | trimmed | containers converted | hand-added placeholder paragraph |
|---|---|---|---|---|---|---|---|
| 01-getting-started.md | vitepress | docs/en/guide/getting-started.md | 6238 | 6049 | yes | 7 | `Hello {name}, your project {project} is ready.` |
| 02-vite-assets.md | vite | docs/guide/assets.md | 6566 | 6300 | yes | 4 |  |
| 03-hotupdate-hook.md | vite | docs/changes/hotupdate-hook.md | 3529 | 3580 | no | 2 | `You have {count} plugins to migrate in {project}.` |
| 04-performance.md | vite | docs/guide/performance.md | 8184 | 6043 | yes | 2 |  |
| 05-asset-handling.md | vitepress | docs/en/guide/asset-handling.md | 4098 | 3981 | no | 2 |  |
| 06-dep-pre-bundling.md | vite | docs/guide/dep-pre-bundling.md | 5651 | 5651 | no | 1 |  |
| 07-vite-cli.md | vite | docs/guide/cli.md | 14606 | 9850 | yes | 0 |  |
| 08-vitepress-cli.md | vitepress | docs/en/reference/cli.md | 3128 | 3098 | no | 0 | `Run this command in {directory} to start the server on port {port}.` |
| 09-using-vue.md | vitepress | docs/en/guide/using-vue.md | 8219 | 6210 | yes | 9 |  |
| 10-env-and-mode.md | vite | docs/guide/env-and-mode.md | 10883 | 6029 | yes | 9 |  |
| 11-vite-guide-index.md | vite | docs/guide/index.md | 11552 | 6009 | yes | 8 |  |
| 12-markdown.md | vitepress | docs/en/guide/markdown.md | 27574 | 6158 | yes | 33 |  |
| 13-ssr-compat.md | vitepress | docs/en/guide/ssr-compat.md | 3638 | 3563 | no | 0 | `Welcome back, {user}. Last build took {duration} seconds.` |
| 14-data-loading.md | vitepress | docs/en/guide/data-loading.md | 7821 | 6021 | yes | 0 |  |
| 15-runtime-api.md | vitepress | docs/en/reference/runtime-api.md | 6966 | 6092 | yes | 0 |  |
| 16-backend-integration.md | vite | docs/guide/backend-integration.md | 11567 | 6384 | yes | 1 |  |
| 17-custom-theme.md | vitepress | docs/en/guide/custom-theme.md | 7725 | 6023 | yes | 0 |  |
| 18-i18n.md | vitepress | docs/en/guide/i18n.md | 5324 | 5209 | no | 0 |  |
| 19-philosophy.md | vite | docs/guide/philosophy.md | 3575 | 3630 | no | 0 | `Version {version} was released on {date} by {author}.` |
| 20-why.md | vite | docs/guide/why.md | 6878 | 6155 | yes | 0 | `Thanks for reading, {name}!` |

These pages were copied from the spike at `6c7c5ef` (`spikes/rich-text-sentinel/corpus/`).
