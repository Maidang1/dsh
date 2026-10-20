import type { NextConfig } from 'next'

/**
 * Static export served by the local Node control service from the same
 * origin as the API (docs/02-technical-architecture.md §3).
 */
const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  transpilePackages: ['@harness-explorer/contracts', '@harness-explorer/trace', '@harness-explorer/lesson-kit'],
}

export default config
