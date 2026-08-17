import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  // 关键：clean:true 会删掉 tsc 刚产出的 entry → UNRESOLVED_ENTRY
  clean: false,
})
