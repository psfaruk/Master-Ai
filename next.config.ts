import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output — produces a self-contained server.js bundle that
  // doesn't need node_modules in production. Perfect for Railway/Docker.
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  reactStrictMode: false,
  // Allow the standalone server to bind to 0.0.0.0 so Railway's proxy can
  // reach it. PORT is injected by Railway.
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
