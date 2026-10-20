/** `pnpm explorer`: open the run store, recover interrupted runs, serve the app. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadBuiltCatalog, loadDevCatalog } from './catalog.ts'
import { RunController } from './controller.ts'
import { startServer } from './server.ts'
import { DEFAULT_RETENTION, RunStore } from './store.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const store = new RunStore(process.env.EXPLORER_STORE ?? join(repoRoot, '.explorer'))
const recovered = await store.recoverInterrupted()
if (recovered.length) console.log(`marked ${recovered.length} unfinished run(s) as interrupted`)

const built = loadBuiltCatalog()
if (!built) console.log('lessons are not built; running stages from source (run `pnpm lessons:build`)')
const catalog = built ?? loadDevCatalog()
const controller = new RunController({ store, catalog, runTimeoutMs: 5 * 60_000, retention: DEFAULT_RETENTION })
const server = await startServer({
  store,
  catalog,
  controller,
  retention: DEFAULT_RETENTION,
  port: Number(process.env.EXPLORER_PORT ?? 4310),
  staticDir: join(repoRoot, 'apps/explorer/out'),
  ...process.env.EXPLORER_TOKEN ? { launchToken: process.env.EXPLORER_TOKEN } : {},
})
console.log(`Harness Explorer: ${server.launchUrl}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    controller.cancel()
    void server.close().then(() => process.exit(0))
  })
}
