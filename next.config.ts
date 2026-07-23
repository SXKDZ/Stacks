import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the floating dev-mode overlay button (the circular "N" indicator).
  devIndicators: false,
  // Allow a throwaway build dir so a verification build never clobbers the
  // running dev server's .next (set NEXT_DIST_DIR for that build only).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
