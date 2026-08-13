import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output — produces a self-contained server.js bundle that
  // doesn't need node_modules in production. Perfect for Railway/Docker.
  // IMPORTANT: standalone mode traces and copies node_modules but does NOT
  // copy .next/static or public/ — those must be copied manually after the
  // build (see the `cp -r` steps in package.json's build script and
  // nixpacks.toml). Skipping that step ships a server that answers with
  // unstyled HTML because its CSS/JS chunks and static assets are missing.
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
