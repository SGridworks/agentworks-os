/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // All pages in (shell) make live API calls to agentos-d.
  // Disable static generation globally — everything is SSR or dynamic.
  staticPageGenerationTimeout: 0,
  webpack(config, { dev }) {
    if (dev) {
      // AWOS Local runs the admin UI as a long-lived local appliance. The
      // persistent dev cache has produced stale server chunk references after
      // watchdog restarts, so prefer slower but deterministic recompiles.
      config.cache = false;
    }
    return config;
  },
};

module.exports = nextConfig;
