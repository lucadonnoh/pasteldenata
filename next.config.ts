import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: process.cwd(),
  },
  // The Hedera settlement route forks leaf-agent processes and uses the
  // gRPC-based SDK; neither survives bundling.
  serverExternalPackages: ["@hashgraph/sdk", "tsx"],
};

export default nextConfig;
