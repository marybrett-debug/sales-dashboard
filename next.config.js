/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // The marketing dashboard HTML is read from disk at request time.
  outputFileTracingIncludes: {
    '/api/marketing': ['./app/api/marketing/dashboard.html'],
  },
}

module.exports = nextConfig
