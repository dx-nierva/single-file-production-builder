import { readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const SCRIPT_TAG = /<script[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g
const STYLESHEET_TAG = /<link[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"[^>]*>/g

/**
 * Chrome refuses any externally-sourced <script type="module" src="...">
 * under a file:// origin (CORS policy has no file:// entry), no matter the
 * path or crossorigin attribute. Inlining the built JS/CSS directly into
 * index.html removes the external fetch entirely, which is the only way to
 * make the build openable by double-clicking dist/index.html.
 *
 * This app has one entry (main.js) and no code-splitting, so Vite always
 * emits exactly one script tag and one stylesheet link. The count checks
 * below turn a future violation of that assumption (e.g. a dynamic import
 * added later) into a loud build failure instead of a silently broken
 * file:// build.
 */
function inlineForFileProtocol() {
  return {
    name: 'inline-for-file-protocol',
    writeBundle(options) {
      const dir = options.dir
      const htmlPath = resolve(dir, 'index.html')
      let html = readFileSync(htmlPath, 'utf8')

      const scriptMatches = [...html.matchAll(SCRIPT_TAG)]
      const styleMatches = [...html.matchAll(STYLESHEET_TAG)]
      if (scriptMatches.length !== 1 || styleMatches.length !== 1) {
        throw new Error(
          `inline-for-file-protocol expects exactly one script and one stylesheet tag, found ${scriptMatches.length} script(s) and ${styleMatches.length} stylesheet(s). This app's single-entry, no-code-splitting assumption no longer holds; update this plugin before shipping.`,
        )
      }

      html = html.replace(SCRIPT_TAG, (_match, src) => {
        const code = readFileSync(resolve(dir, src), 'utf8')
        return `<script type="module">\n${code}\n</script>`
      })

      html = html.replace(STYLESHEET_TAG, (_match, href) => {
        const code = readFileSync(resolve(dir, href), 'utf8')
        return `<style>\n${code}\n</style>`
      })

      writeFileSync(htmlPath, html)

      const assetsDir = resolve(dir, 'assets')
      for (const file of readdirSync(assetsDir)) {
        rmSync(resolve(assetsDir, file))
      }
    },
  }
}

export default {
  base: './',
  plugins: [inlineForFileProtocol()],
}
