import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MaterialRightsControl } from './MaterialRightsControl.tsx'

const workspaceId = 'ws_material_rights_adjust_fixture'
const initial = {
  id: 'asset_rights_adjust_fixture', workspaceId, name: '已授权后调整范围.png',
  mimeType: 'image/png', sizeBytes: 1024, sha256: 'a'.repeat(64),
  scanStatus: 'clean', parseStatus: 'succeeded', rightsStatus: 'approved',
  rightsScope: 'commercial_authorized', revision: 7, source: 'merchant_upload', references: [],
  readiness: { status: 'ready', reasons: [] },
  display: { primaryStatus: 'ready', label: '商用权益已确认', sourceState: 'ready', reasons: [], nextAction: { method: 'asset.rights.update', label: '调整权益范围', allowed: true } },
}

function Fixture() {
  const [asset, setAsset] = useState(initial)
  return <main>
    <h1>素材权益调整本地夹具</h1>
    <MaterialRightsControl asset={asset} baseUrl="/api" onSaved={setAsset} />
  </main>
}

createRoot(document.getElementById('root')).render(<Fixture />)
