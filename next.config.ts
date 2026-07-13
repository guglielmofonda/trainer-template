import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine is pure TS; nothing exotic needed. Keep strict checks on during build.
  reactStrictMode: true,
  // The committed data/*.json files (profile, store snapshot) are read with fs at
  // runtime; make sure they ship inside the serverless bundle on Vercel.
  outputFileTracingIncludes: {
    "/**/*": ["./data/*.json"],
  },
};

export default nextConfig;
