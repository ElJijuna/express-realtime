import { createEslintConfig } from 'super-configs/eslint';

export default createEslintConfig({
  runtime: 'node',
  language: 'ts',
  typeChecked: true,
  testFramework: 'vitest',
  ignores: ['dist/**', 'coverage/**', 'docs/**', 'node_modules/**', 'eslint.config.js'],
});
