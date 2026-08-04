import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // A leading underscore is the codebase's existing "deliberately unused"
      // marker. It matters for positional parameters that can't just be deleted:
      // `buildGraph(topology, expandedVpcGroups, …, _expandedIsolatedTgwGroups, …)`
      // has callers passing later arguments by position, so removing a spent
      // middle parameter would silently shift every argument after it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Tests build fixtures by hand and cast partial objects to the full AWS
    // response types (`{ connectionId: 'c1', ... } as any`) so a case only spells
    // out the fields it exercises. Spelling out every field would bury the intent
    // of each test in boilerplate, so `any` is deliberate here rather than a
    // shortcut worth flagging 258 times.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
