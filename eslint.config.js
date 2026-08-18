import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      ".chronorift/**",
      "eslint.config.js",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "vitest.config.ts",
            "vitest.live.config.ts",
            "vitest.godot.config.ts",
            "vitest.sandbox.config.ts",
            "vitest.godot-sandbox.config.ts",
            "vitest.external-project.config.ts",
            "vitest.external-semantic.config.ts",
            "vitest.m5-live.config.ts",
            "vitest.m6-live.config.ts",
            "vitest.m7-live.config.ts",
            "vitest.m7-r3-live.config.ts",
            "vitest.m7-r4-live.config.ts",
            "vitest.m7-r5-live.config.ts",
            "vitest.m7-r6-live.config.ts",
            "vitest.m7-r7-live.config.ts",
            "vitest.vnext-live.config.ts",
            ".chronorift/m7-r7-live/freeze.ts",
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.spec.ts",
      "**/test/**/*.ts",
      "**/tests/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
);
