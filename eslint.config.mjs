import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Isolated verification builds (NEXT_DIST_DIR=.next-verify).
    ".next-verify/**",
    // Throwaway probe scripts from agent-driven verification runs. They are
    // scratch, never part of the suite, and are gitignored.
    "tests/**/*probe*",
    "tests/**/__scratch*",
    "tests/_*",
    "tmp-probe/**",
    "tmpprobe/**",
    "tests/**/rvw-*",
  ]),
  {
    // set-state-in-effect fires on the mount-time reads of client-only values
    // (localStorage, navigator) that keep SSR and the first client render in
    // agreement, and on drafts re-syncing when the record they edit changes.
    // A lazy initializer would trade the warning for a hydration mismatch, so
    // these stay as warnings rather than being "fixed"; CI fails on errors.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/refs": "warn",
      // next/image optimizes remote and build-time images through a loader.
      // Every <img> here is either the local favicon SVG or a blob: URL for a
      // file the user just attached, so there is nothing to optimize and the
      // wrapper would only add layout constraints.
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;
