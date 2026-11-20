// Stable package entry.
//
// DSH's loader opens `<package>/index.js` for a bundle row, while the real Host
// implementation lives in `src/host/`. Keep this file as a thin re-export: it
// changes nothing about the module contract (`apply` + `Config`).
export { apply, Config } from './src/host/index.js'
