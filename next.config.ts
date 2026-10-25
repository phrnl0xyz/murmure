import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Tunnel https pour tester sur iPhone pendant le développement.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
