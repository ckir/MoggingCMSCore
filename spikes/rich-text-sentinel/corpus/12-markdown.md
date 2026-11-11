# Markdown Extensions

VitePress comes with built in Markdown Extensions.

## Header Anchors

Headers automatically get anchor links applied. Rendering of anchors can be configured using the `markdown.anchor` option.

### Custom anchors

To specify a custom anchor tag for a heading instead of using the auto-generated one, add a suffix to the heading:

```
# Using custom anchors {#my-anchor}
```

This allows you to link to the heading as `#my-anchor` instead of the default `#using-custom-anchors`.

## Links

Both internal and external links get special treatment.

### Internal Links

Internal links are converted to router links for SPA navigation. Also, every `index.md` contained in each sub-directory will automatically be converted to `index.html`, with corresponding URL `/`.

For example, given the following directory structure:

```
.
├─ index.md
├─ foo
│  ├─ index.md
│  ├─ one.md
│  └─ two.md
└─ bar
   ├─ index.md
   ├─ three.md
   └─ four.md
```

And providing you are in `foo/one.md`:

```md
[Home](/) <!-- sends the user to the root index.md -->
[foo](/foo/) <!-- sends the user to index.html of directory foo -->
[foo heading](./#heading) <!-- anchors user to a heading in the foo index file -->
[bar - three](../bar/three) <!-- you can omit extension -->
[bar - three](../bar/three.md) <!-- you can append .md -->
[bar - four](../bar/four.html) <!-- or you can append .html -->
```

### Page Suffix

Pages and internal links get generated with the `.html` suffix by default.

### External Links

Outbound links automatically get `target="_blank" rel="noreferrer"`:

- [vuejs.org](https://vuejs.org)
- [VitePress on GitHub](https://github.com/vuejs/vitepress)

## Frontmatter

[YAML frontmatter](https://jekyllrb.com/docs/front-matter/) is supported out of the box:

```yaml
---
title: Blogging Like a Hacker
lang: en-US
---
```

This data will be available to the rest of the page, along with all custom and theming components.

For more details, see [Frontmatter](../reference/frontmatter-config).

## GitHub-Style Tables

**Input**

```md
| Tables        |      Are      |  Cool |
| ------------- | :-----------: | ----: |
| col 3 is      | right-aligned | $1600 |
| col 2 is      |   centered    |   $12 |
| zebra stripes |   are neat    |    $1 |
```

**Output**

| Tables        |      Are      |   Cool |
| ------------- | :-----------: | -----: |
| col 3 is      | right-aligned | \$1600 |
| col 2 is      |   centered    |   \$12 |
| zebra stripes |   are neat    |    \$1 |

## Task Lists

**Input**

```md
- [ ] Write the press release
- [x] Update the website
```

**Output**

- [ ] Write the press release
- [x] Update the website

## Footnotes

**Input**

```md
Footnotes are supported[^1], including inline ones^[This is an inline footnote.].

[^1]: Definitions can contain **markdown** and are rendered at the end of the page.
```

**Output**

Footnotes are supported[^1], including inline ones^[This is an inline footnote.].

[^1]: Definitions can contain **markdown** and are rendered at the end of the page.

## Emoji :tada:

**Input**

```
:tada: :100:
```

**Output**

:tada: :100:

A [list of all emojis](https://github.com/mdit-plugins/mdit-plugins/blob/main/packages/plugin-emoji/src/data/full.ts) is available.

## Table of Contents

**Input**

```
[[toc]]
```

**Output**

[[toc]]

Rendering of the TOC can be configured using the `markdown.toc` option.

## Custom Containers

Custom containers can be defined by their types, titles, and contents.

### Default Title

**Input**

```md
:::info
This is an info box.
:::

:::tip
This is a tip.
:::

:::warning
This is a warning.
:::

:::danger
This is a dangerous warning.
:::

:::details
This is a details block.
:::
```

**Output**

:::info
This is an info box.
:::

:::tip
This is a tip.
:::

:::warning
This is a warning.
:::

:::danger
This is a dangerous warning.
:::

:::details
This is a details block.
:::

### Custom Title

You may set custom title by appending the text right after the "type" of the container.

**Input**

````md
:::danger[STOP]
Danger zone, do not proceed
:::

:::details[Click me to toggle the code]
```js
console.log('Hello, VitePress!')
```
:::
````

**Output**

:::danger[STOP]
Danger zone, do not proceed
:::

:::details[Click me to toggle the code]
```js
console.log('Hello, VitePress!')
```
:::

Also, you may set custom titles globally by adding the following content in site config, helpful if not writing in English:

```ts
// config.ts
export default defineConfig({
  // ...
  markdown: {
    container: {
      tipLabel: '提示',
      warningLabel: '警告',
      dangerLabel: '危险',
      infoLabel: '信息',
      detailsLabel: '详细信息'
    }
  }
  // ...
})
```

On multilingual sites, these labels can also be overridden per locale - see [Per-locale Markdown Strings](./i18n#per-locale-markdown-strings).

### Registering New Containers

Beyond the built-in types, you can register additional containers by mapping their names to their default titles:

```ts
// config.ts
export default defineConfig({
  // ...
  markdown: {
    container: {
      customContainers: {
        success: 'SUCCESS'
      }
    }
  }
  // ...
})
```

Registered names work like the built-in ones - including custom titles, attributes, and the [GitHub-style alert syntax](#github-flavored-alerts):

```md
:::success
You have completed the walkthrough!
:::

> [!SUCCESS] Custom title
> This renders the same way.
```

New containers ship without any styling, so add some in your theme using the container name as the class. For this example, the default theme's palette already provides fitting colors:

```css
/* .vitepress/theme/custom.css */
.custom-block.success {
  border-color: transparent;
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-success-soft);
}
```

### Nesting

The `:::` markers follow the same rules as fenced code blocks (` ``` `): a fence is only closed by a matching fence that is **at least as long** as the one that opened it. To nest containers (or to mix them with [code groups](#code-groups)) make the outer fence longer than the ones inside it.
