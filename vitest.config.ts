import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const dir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    root: dir,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
