import { getEslintConfig } from "eslint-config-setup";

const config = await getEslintConfig({ node: true, oxlint: true });

for (const block of config) {
  const parserOptions = block.languageOptions?.parserOptions;
  if (typeof parserOptions === "object" && parserOptions !== null) {
    Object.assign(parserOptions, { tsconfigRootDir: import.meta.dirname });
  }
}

config.unshift({
  ignores: ["dist/**", "coverage/**", "node_modules/**", "**/*.json"],
});

export default config;
