import js from '@eslint/js';
import html from 'eslint-plugin-html';
import globals from 'globals';

export default [
  js.configs.recommended,

  // Main process, preload, bridge, build hooks — CommonJS + Node globals.
  {
    files: ['main.js', 'preload.js', 'afterPack.js', 'bridge/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // We deliberately swallow some errors (best-effort cleanup, optional
      // features) — don't fight that pattern, just catch real bugs.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Renderer — the app's inline <script> block. This is what would have
  // caught the "Settings modal won't open" bug (a call to a function that
  // no longer existed) before it ever shipped.
  {
    files: ['renderer/**/*.html'],
    plugins: { html },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, deepbook: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off', // the app defines many onclick-only handlers; not worth the noise
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-func-assign': 'off', // app deliberately monkey-patches openProject() after its declaration
    },
  },
];
