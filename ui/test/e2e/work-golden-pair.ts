import { join } from "node:path"
import { openAuthDatabase } from "../../../sidecar/src/cli/auth/database"
import { openAuthStore } from "../../../sidecar/src/cli/auth/store"

const directory = process.argv[2]
if (!directory) throw new Error("Missing synthetic data directory")
const filename = join(directory, "auth.db")
// This one-shot fixture initializes a disposable database before the server starts listening.
const database = openAuthDatabase(filename)
database.query("UPDATE people SET name=? WHERE id='owner'").run("Pessoa demo")
database.close()
const store = await openAuthStore({ filename })
const result = await store.createPairingCode()
process.stdout.write(`Pairing code: ${result.code}\n`)
await store.close()
