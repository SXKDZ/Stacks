import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the floating dev-mode overlay button (the circular "N" indicator).
  devIndicators: false,
  experimental: {
    // proxy.ts matches /api/:path*, so Next clones and buffers the body of every
    // API request and cuts it at this limit. The default is 10 MiB and the cut is
    // a clean end of stream, not an error: a 41 MB PDF upload was stored as
    // 10,470,576 bytes with a 200 response. Keep this at or above the largest
    // body a route accepts (PDF_LIMIT in app/lib/local-files.ts).
    proxyClientMaxBodySize: "150mb",
  },
  // Allow a throwaway build dir so a verification build never clobbers the
  // running dev server's .next (set NEXT_DIST_DIR for that build only).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
