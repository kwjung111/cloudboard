import type { NextConfig } from "next";

const deploymentId = process.env.NEXT_DEPLOYMENT_ID?.trim();

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  ...(deploymentId ? { deploymentId } : {}),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
