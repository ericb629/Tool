import { defineConfig } from 'vitest/config'

// Tests target the pure/Node-side logic: the shared manifest layer (geometry
// math, quantity derivation, validation) and the main-process ManifestStore.
// Renderer components are not covered here - see docs/INVENTORY.md.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
})
