import { createRoot } from 'react-dom/client'
import { configureMerchantWorkspaceScope } from './api.js'
import { CampaignLifecyclePanel } from './CampaignLifecyclePanel.js'
import './styles.css'

configureMerchantWorkspaceScope(['ws_campaign_lifecycle_recovery_fixture'], 'ws_campaign_lifecycle_recovery_fixture')

createRoot(document.getElementById('root')!).render(
  <main className="page task-page" style={{ maxWidth: 1280, margin: '36px auto', padding: 24 }}>
    <h1>批量任务操作恢复验收</h1>
    <CampaignLifecyclePanel baseUrl="/api" />
  </main>,
)
