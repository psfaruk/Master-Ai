import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output — produces a self-contained server.js bundle that
  // doesn't need node_modules in production. Perfect for Railway/Docker.
  // Next.js 13.4+ automatically traces and copies static + public assets
  // into .next/standalone, so no manual `cp -r` is needed in the build
  // script (the old build script's `cp` was a no-op or worse).
  output: "standalone",
  // Re-enabled strict mode + type checking. The previous flags were
  // silencing real bugs that should fail the build, not ship to production.
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
