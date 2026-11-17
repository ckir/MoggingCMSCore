/** The Astro integration object `@mogging/starlight` returns: a name and no hooks. */
export type MoggingStarlightIntegration = { name: "@mogging/starlight"; hooks: Record<string, never> };

/**
 * The Astro integration of MoggingCMS for Starlight sites. It is a deliberate no-op today: it registers no hooks, so
 * adding it to `astro.config` changes nothing about the build. This entry imports nothing at run time, so loading it
 * inside an Astro config never pulls the engine, a database driver or the markdown toolchain into the site build.
 *
 * @returns A fresh integration object named `@mogging/starlight` with an empty `hooks` map.
 */
export default function moggingStarlight(): MoggingStarlightIntegration {
  return { name: "@mogging/starlight", hooks: {} };
}
