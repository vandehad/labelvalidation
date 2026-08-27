import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Scanner input must never be cached or prerendered.
  experimental: {},
}

export default nextConfig
