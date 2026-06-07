const agentosApiUrl =
  process.env.AGENTOS_API_URL ??
  'http://127.0.0.1:7710';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // All pages in (shell) make live API calls to agentos-d.
  // Disable static generation globally — everything is SSR or dynamic.
  staticPageGenerationTimeout: 0,
  // Disable the pages directory entirely to prevent conflicts.
  // We use App Router only.
  async rewrites() {
    return {
      fallback: [
        {
          source: '/api/:path*',
          destination: `${agentosApiUrl}/api/:path*`,
        },
      ],
    };
  },
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
