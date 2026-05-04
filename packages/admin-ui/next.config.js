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
          destination: 'http://127.0.0.1:7710/api/:path*',
        },
      ],
    };
  },
};

module.exports = nextConfig;
