/**
 * Print the exact `/plugins` URL of this bundle's client artifact.
 *
 * The harness serves a client bundle only at its current revision URL, which is
 * `sha1("plugin-artifact" + NUL + length-framed mtimeMs/ctimeMs/size)` truncated
 * to 12 hex characters (see `artifactRevision`/`framedHash` in
 * `@deepseek-ai/dsh-client-modules`). Recomputing it here lets a probe confirm
 * that the running server composed and serves this bundle.
 *
 * Run with: node tools/plugin-url.mjs
 */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
const packageName = '@local/dsh-right-click-row-menu'
const { mtimeMs, ctimeMs, size } = statSync(clientPath)

const hash = createHash('sha1').update('plugin-artifact').update('\0')
for (const part of [String(mtimeMs), String(ctimeMs), String(size)]) {
  hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
}
const rev = hash.digest('hex').slice(0, 12)

console.log(JSON.stringify({
  clientPath,
  mtimeMs,
  ctimeMs,
  size,
  rev,
  pathname: `/plugins/${packageName}/client.js`,
  url: `http://127.0.0.1:3080/plugins/${packageName}/client.js?rev=${rev}`,
}, null, 2))
