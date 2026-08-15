import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The end-to-end transfer tests hash real multi-megabyte payloads. They run
    // in well under a second on an idle machine, but the 5s default is tight
    // when a build or another suite is competing for the CPU.
    testTimeout: 20_000
  }
})
