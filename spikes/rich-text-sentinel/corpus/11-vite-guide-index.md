# Getting Started

<audio id="vite-audio">
  <source src="/vite.mp3" type="audio/mpeg">
</audio>

## Overview

Vite (French word for "quick", pronounced `/viːt/`<button style="border:none;padding:3px;border-radius:4px;vertical-align:bottom" id="play-vite-audio" aria-label="pronounce" onclick="document.getElementById('vite-audio').play();"><svg style="height:2em;width:2em"><use href="../images/voice.svg?no-inline#voice" /></svg></button>, like "veet") is a build tool that aims to provide a faster and leaner development experience for modern web projects. It consists of two major parts:

- A dev server that provides [rich feature enhancements](./features) over [native ES modules](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules), for example extremely fast [Hot Module Replacement (HMR)](./features#hot-module-replacement).

- A build command that bundles your code with [Rolldown](https://rolldown.rs), pre-configured to output highly optimized static assets for production.

Vite is opinionated and comes with sensible defaults out of the box. Read about what's possible in the [Features Guide](./features). Support for frameworks or integration with other tools is possible through [Plugins](./using-plugins). The [Config Section](../config/) explains how to adapt Vite to your project if needed.

Vite is also highly extensible via its [Plugin API](./api-plugin) and [JavaScript API](./api-javascript) with full typing support.

You can learn more about the rationale behind the project in the [Why Vite](./why) section.

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq?via=vite" title="Free Vite Course on Scrimba">Learn Vite through interactive tutorials on Scrimba</ScrimbaLink>

## Browser Support

During development, Vite assumes that a modern browser is used. This means the browser supports most of the latest JavaScript and CSS features. For that reason, Vite sets [`esnext` as the transform target](https://oxc.rs/docs/guide/usage/transformer/lowering.html#target). This prevents syntax lowering, letting Vite serve modules as close as possible to the original source code. Vite injects some runtime code to make the development server work. This code uses features included in [Baseline](https://web-platform-dx.github.io/baseline/) Newly Available at the time of each major release (2026-01-01 for this major).

For production builds, Vite by default targets [Baseline](https://web-platform-dx.github.io/baseline/) Widely Available browser versions as of a date fixed for each major release. For this major, that corresponds to [browser versions released around mid-2023](https://web-platform-dx.github.io/supported-browsers/?widelyAvailableOnDate=2026-01-01). The target can be lowered via configuration. Additionally, legacy browsers can be supported via the official [@vitejs/plugin-legacy](https://github.com/vitejs/vite/tree/main/packages/plugin-legacy). See the [Building for Production](./build) section for more details.

## Trying Vite Online

You can try Vite online on [StackBlitz](https://vite.new/). It runs the Vite-based build setup directly in the browser, so it is almost identical to the local setup but doesn't require installing anything on your machine. You can navigate to `vite.new/{template}` to select which framework to use.

The supported template presets are:

|             JavaScript              |                TypeScript                 |
| :---------------------------------: | :---------------------------------------: |
| [vanilla](https://vite.new/vanilla) | [vanilla-ts](https://vite.new/vanilla-ts) |
|     [vue](https://vite.new/vue)     |     [vue-ts](https://vite.new/vue-ts)     |
|   [react](https://vite.new/react)   |   [react-ts](https://vite.new/react-ts)   |
|  [preact](https://vite.new/preact)  |  [preact-ts](https://vite.new/preact-ts)  |
|     [lit](https://vite.new/lit)     |     [lit-ts](https://vite.new/lit-ts)     |
|  [svelte](https://vite.new/svelte)  |  [svelte-ts](https://vite.new/svelte-ts)  |
|   [solid](https://vite.new/solid)   |   [solid-ts](https://vite.new/solid-ts)   |
|    [qwik](https://vite.new/qwik)    |    [qwik-ts](https://vite.new/qwik-ts)    |

## Scaffolding Your First Vite Project

:::code-group

```bash [npm]
$ npm create vite@latest
```

```bash [Yarn]
$ yarn create vite
```

```bash [pnpm]
$ pnpm create vite
```

```bash [Bun]
$ bun create vite
```

```bash [Deno]
$ deno init --npm vite
```

:::

Then follow the prompts!

<ScrimbaLink href="https://scrimba.com/intro-to-vite-c03p6pbbdq/~0yhj?via=vite" title="Scaffolding Your First Vite Project">Watch an interactive lesson on Scrimba</ScrimbaLink>

:::tip[Compatibility Note]
Vite requires [Node.js](https://nodejs.org/en/) version 20.19+, 22.12+. However, some templates require a higher Node.js version to work, please upgrade if your package manager warns about it.
:::

::::details[Using create vite with command line options]

You can also directly specify the project name and the template you want to use via additional command line options. For example, to scaffold a Vite + Vue project, run:

:::code-group

```bash [npm]
# npm 7+, extra double-dash is needed:
$ npm create vite@latest my-vue-app -- --template vue
```

```bash [Yarn]
$ yarn create vite my-vue-app --template vue
```

```bash [pnpm]
$ pnpm create vite my-vue-app --template vue
```

```bash [Bun]
$ bun create vite my-vue-app --template vue
```

```bash [Deno]
$ deno init --npm vite my-vue-app --template vue
```

:::

See [create-vite](https://github.com/vitejs/vite/tree/main/packages/create-vite) for more details on each supported template: `vanilla`, `vanilla-ts`, `vue`, `vue-ts`, `react`, `react-compiler`, `react-ts`, `react-compiler-ts`, `preact`, `preact-ts`, `lit`, `lit-ts`, `svelte`, `svelte-ts`, `solid`, `solid-ts`, `qwik`, `qwik-ts`.

You can use `.` for the project name to scaffold in the current directory.

To create a project without interactive prompts, you can use the `--no-interactive` flag.

::::
