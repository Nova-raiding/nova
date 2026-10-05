import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
const source = resolve(process.argv[2])
const mode = process.argv[3]
const home = mode === 'isolated' ? resolve(process.argv[4]) : homedir()
const output = resolve(process.argv[5])
function tree(root, rel = '') {
  return readdirSync(join(root, rel)).sort().flatMap(name => {
    const path = join(rel, name), stat = lstatSync(join(root, path))
    if (stat.isDirectory()) return tree(root, path)
    return [{ path, sha256: createHash('sha256').update(stat.isSymbolicLink() ? `link:${readlinkSync(join(root,path))}` : readFileSync(join(root,path))).digest('hex'), mode: stat.mode, size: stat.size }]
  })
}
const previousPath = join(home, 'plugins/merchant-marketing')
const before = existsSync(previousPath) ? tree(previousPath) : null
const configPath = join(home, '.codex/config.toml')
const oldConfig = existsSync(configPath) ? readFileSync(configPath) : null
const { installBundledPlugin } = await import(`${source}/scripts/install-chatgpt-bundled.mjs`)
mkdirSync(home, { recursive: true })
const result = installBundledPlugin({ sourceRoot: source, home, codexHome: join(home,'.codex'), agentsHome: join(home,'.agents') })
const preserved = before ? JSON.stringify(before) === JSON.stringify(tree(result.previous_source)) : true
const configPreserved = oldConfig ? readFileSync(result.previous_config).equals(oldConfig) : true
const evidence = { ...result, previous_source_preserved: preserved, previous_file_count: before?.length ?? 0, previous_config_preserved: configPreserved, profile: JSON.parse(readFileSync(join(result.installed,'bundle-profile.json'))), bundle_status: JSON.parse(readFileSync(join(result.installed,'bundle-status.json'))), host_restarted: false, host_loaded_new_snapshot_verified: false }
writeFileSync(output, JSON.stringify(evidence,null,2)+'\n')
console.log(JSON.stringify({ok:result.ok,version:result.version,installed:result.installed,previous_source:result.previous_source,previous_source_preserved:preserved,previous_config_preserved:configPreserved}))
if (!preserved || !configPreserved) process.exitCode = 1
