import tseslint from 'typescript-eslint';
import base from './eslint.base.mjs';

export default tseslint.config(
  {
    // web/ owns its own toolchain; src/vendor/ holds byte-identical copies of
    // @nanohype/runtime modules, linted at their source of truth — local lint
    // fixes there would be drift.
    ignores: ['.next/', 'web/', 'src/vendor/'],
  },
  // Org base (vendored from nanohype library/config, drift-gated).
  ...base,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
