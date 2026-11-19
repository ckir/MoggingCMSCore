/**
 * The connection pool size of the `mogging` CLI. It is also the upper bound of `mogging import --concurrency`: a
 * Starlight import holds one connection per concurrent file write, so a larger request could not run any faster.
 */
export const CLI_POOL_MAX = 8;
