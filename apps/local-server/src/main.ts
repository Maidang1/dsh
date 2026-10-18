/** `pnpm explorer`: open the run store, recover interrupted runs, serve the app. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadDevCatalog } from './catalog.ts'
import { RunController } from './controller.ts'
import { startServer } from './server.ts'
import { RunStore } from './store.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const store = new RunStore(join(repoRoot, '.explorer'))
const recovered = await store.recoverInterrupted()
if (recovered.length) console.log(`marked ${recovered.length} unfinished run(s) as interrupted`)

const catalog = loadDevCatalog()
const controller = new RunController({ store, catalog, runTimeoutMs: 5 * 60_000 })
const server = await startServer({
  store,
  catalog,
  controller,
  port: Number(process.env.EXPLORER_PORT ?? 4310),
  staticDir: join(repoRoot, 'apps/explorer/out'),
})
console.log(`Harness Explorer: ${server.launchUrl}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    controller.cancel()
    void server.close().then(() => process.exit(0))
  })
}
