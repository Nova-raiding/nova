import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { configureMerchantWorkspaceScope } from './api'
import { PublishHistoryPanel } from './PublishHistoryPanel'
import './styles.css'

configureMerchantWorkspaceScope(['ws_publish_history_local_mock'], 'ws_publish_history_local_mock')

function PublishHistoryVisual() {
  const testServiceToggle = new URLSearchParams(window.location.search).has('test_service_toggle')
  const [serviceConfigured, setServiceConfigured] = useState(true)
  return (
    <main className="page task-page" style={{ maxWidth: 1280, margin: '36px auto', padding: 24 }}>
      <h1>发布记录本地验收</h1>
      {testServiceToggle && <button type="button" onClick={() => setServiceConfigured(value => !value)}>切换服务配置</button>}
      <PublishHistoryPanel baseUrl={serviceConfigured ? '/api' : undefined} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<PublishHistoryVisual />)
