import sharedConfig from 'super-configs/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(sharedConfig, {
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
