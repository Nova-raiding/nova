import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ECS candidate bundle contract', () => {
  it('stays ECS-only and records that alerts are disabled', () => {
    const script = readFileSync('infra/scripts/prepare-ecs-candidate-bundle.sh', 'utf8')
    const manifest = script.slice(script.indexOf("cat > \"$manifest\" <<'EOF'"), script.indexOf('\nEOF', script.indexOf("cat > \"$manifest\" <<'EOF'")))

    expect(manifest).not.toMatch(/kubernetes|kubectl|aliyun-ack-rrsa/u)
    expect(script).toContain('This candidate is ECS-only')
    expect(script).toContain('Alerts are disabled for this candidate')
    expect(script).not.toContain('alert delivery, and rollback')
  })
})
