# Backend Integration

:::tip[Note]
If you want to serve the HTML using a traditional backend (e.g. Rails, Laravel) but use Vite for serving assets, check for existing integrations listed in [Awesome Vite](https://github.com/vitejs/awesome-vite#integrations-with-backends).

If you need a custom integration, you can follow the steps in this guide to configure it manually.
:::

1. In your Vite config, configure the entry and enable build manifest:

   ```js twoslash [vite.config.js]
   import { defineConfig } from 'vite'
   // ---cut---
   export default defineConfig({
     // overwrite default .html entry
     input: '/path/to/main.js',
     server: {
       cors: {
         // the origin you will be accessing via browser
         origin: 'http://my-backend.example.com',
       },
     },
     build: {
       // generate .vite/manifest.json in outDir
       manifest: true,
     },
   })
   ```

   If you haven't disabled the [module preload polyfill](/config/build-options.md#build-polyfillmodulepreload), you also need to import the polyfill in your entry

   ```js
   // add the beginning of your app entry
   import 'vite/modulepreload-polyfill'
   ```

2. For development, inject the following in your server's HTML template (substitute `http://localhost:5173` with the local URL Vite is running at):

   ```html
   <!-- if development -->
   <script type="module" src="http://localhost:5173/@vite/client"></script>
   <script type="module" src="http://localhost:5173/main.js"></script>
   ```

   In order to properly serve assets, you have two options:
   - Make sure the server is configured to proxy static assets requests to the Vite server
   - Set [`server.origin`](/config/server-options.md#server-origin) so that generated asset URLs will be resolved using the back-end server URL instead of a relative path

   This is needed for assets such as images to load properly.

   Note if you are using React with `@vitejs/plugin-react`, you'll also need to add this before the above scripts, since the plugin is not able to modify the HTML you are serving (substitute `http://localhost:5173` with the local URL Vite is running at):

   ```html
   <script type="module">
     import RefreshRuntime from 'http://localhost:5173/@react-refresh'
     RefreshRuntime.injectIntoGlobalHook(window)
     window.$RefreshReg$ = () => {}
     window.$RefreshSig$ = () => (type) => type
     window.__vite_plugin_react_preamble_installed__ = true
   </script>
   ```

3. For production, after running `vite build`, a `.vite/manifest.json` file will be generated alongside other asset files. An example manifest file looks like this:

   ```json [.vite/manifest.json] style:max-height:400px
   {
     "_shared-B7PI925R.js": {
       "file": "assets/shared-B7PI925R.js",
       "name": "shared",
       "css": ["assets/shared-ChJ_j-JJ.css"]
     },
     "_shared-ChJ_j-JJ.css": {
       "file": "assets/shared-ChJ_j-JJ.css",
       "src": "_shared-ChJ_j-JJ.css"
     },
     "logo.svg": {
       "file": "assets/logo-BuPIv-2h.svg",
       "src": "logo.svg"
     },
     "baz.js": {
       "file": "assets/baz-B2H3sXNv.js",
       "name": "baz",
       "src": "baz.js",
       "isDynamicEntry": true
     },
     "views/bar.js": {
       "file": "assets/bar-gkvgaI9m.js",
       "name": "bar",
       "src": "views/bar.js",
       "isEntry": true,
       "imports": ["_shared-B7PI925R.js"],
       "dynamicImports": ["baz.js"]
     },
     "views/foo.js": {
       "file": "assets/foo-BRBmoGS9.js",
       "name": "foo",
       "src": "views/foo.js",
       "isEntry": true,
       "imports": ["_shared-B7PI925R.js"],
       "css": ["assets/foo-5UjPuW-k.css"]
     }
   }
   ```

   The manifest maps source files to their build outputs and dependencies:

   ```dot
   digraph manifest {
     rankdir=TB
     node [shape=box style="rounded,filled" fontname="Arial" fontsize=10 margin="0.2,0.1" fontcolor="${#3c3c43|#ffffff}" color="${#c2c2c4|#3c3f44}"]
     edge [color="${#67676c|#98989f}" fontname="Arial" fontsize=9 fontcolor="${#67676c|#98989f}"]
     bgcolor="transparent"

     foo [label="views/foo.js\n(entry)" fillcolor="${#e9eaff|#222541}"]
     bar [label="views/bar.js\n(entry)" fillcolor="${#e9eaff|#222541}"]
     shared [label="_shared-B7PI925R.js\n(common chunk)" fillcolor="${#f2ecfc|#2c273e}"]
     baz [label="baz.js\n(dynamic import)" fillcolor="${#fcf4dc|#38301a}"]
     foocss [label="foo.css" shape=ellipse fillcolor="${#fde4e8|#3a1d27}"]
     sharedcss [label="shared.css" shape=ellipse fillcolor="${#fde4e8|#3a1d27}"]
     logo [label="logo.svg\n(asset)" shape=ellipse fillcolor="${#def5ed|#15312d}"]

     foo -> shared [label="imports"]
     bar -> shared [label="imports"]
     bar -> baz [label="dynamicImports" style=dashed]
     foo -> foocss [label="css"]
     shared -> sharedcss [label="css"]
   }
   ```

   The manifest has a `Record<name, chunk>` structure where each chunk follows the `ManifestChunk` interface:

   ```ts style:max-height:400px
   interface ManifestChunk {
     /**
      * The input file name of this chunk / asset if known
      */
     src?: string
     /**
      * The output file name of this chunk / asset
      */
     file: string
     /**
      * The list of CSS files imported by this chunk
      */
     css?: string[]
     /**
      * The list of asset files imported by this chunk, excluding CSS files
      */
     assets?: string[]
     /**
      * Whether this chunk or asset is an entry point
      */
     isEntry?: boolean
     /**
      * The name of this chunk / asset if known
      */
     name?: string
     /**
      * Whether this chunk is a dynamic entry point
      *
      * This field is only present in JS chunks.
      */
     isDynamicEntry?: boolean
     /**
      * Whether this chunk belongs to a web worker bundle.
      */
     isWorker?: boolean
     /**
      * Whether this chunk is the entry point of a web worker bundle.
      */
     isWorkerEntry?: boolean
     /**
      * The list of statically imported chunks by this chunk
      *
      * The values are the keys of the manifest. This field is only present in JS chunks.
      */
     imports?: string[]
     /**
      * The list of dynamically imported chunks by this chunk
      *
      * The values are the keys of the manifest. This field is only present in JS chunks.
      */
     dynamicImports?: string[]
   }
   ```
