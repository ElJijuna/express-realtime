// super-configs/vitest ships without type declarations.
declare module 'super-configs/vitest' {
  import type { ViteUserConfig } from 'vitest/config';

  const config: ViteUserConfig;

  export default config;
}
