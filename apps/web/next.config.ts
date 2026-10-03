import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The shared package is consumed as TypeScript source.
  transpilePackages: ['@crm/shared'],
};

export default nextConfig;
