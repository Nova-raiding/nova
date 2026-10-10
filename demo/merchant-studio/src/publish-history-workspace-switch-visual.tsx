import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { activateMerchantWorkspace, configureMerchantWorkspaceScope } from './api'
import { PublishHistoryPanel } from './PublishHistoryPanel'
import './styles.css'

const workspaceA = 'ws_publish_history_alpha'
const workspaceB = 'ws_publish_history_beta'
configureMerchantWorkspaceScope([workspaceA, workspaceB], workspaceA)

function PublishHistoryWorkspaceSwitchVisual() {
  const [workspaceId, setWorkspaceId] = useState(workspaceA)
  const nextWorkspace = workspaceId === workspaceA ? workspaceB : workspaceA
  const switchWorkspace = () => {
    activateMerchantWorkspace(nextWorkspace)
    setWorkspaceId(nextWorkspace)
  }

  return (
    <main className="page task-page" style={{ maxWidth: 1280, margin: '36px auto', padding: 24 }}>
      <h1>发布记录工作区切换本地验收</h1>
      <p role="status">当前工作区：{workspaceId}</p>
      <button type="button" onClick={switchWorkspace}>切换到工作区 {nextWorkspace === workspaceA ? 'A' : 'B'}</button>
      <PublishHistoryPanel key={workspaceId} baseUrl="/api" />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<PublishHistoryWorkspaceSwitchVisual />)
