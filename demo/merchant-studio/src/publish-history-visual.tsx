import { createRoot } from 'react-dom/client'
import { PublishHistoryPanel } from './PublishHistoryPanel'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <main className="page task-page" style={{ maxWidth: 1280, margin: '36px auto', padding: 24 }}>
    <h1>发布记录本地验收</h1>
    <PublishHistoryPanel baseUrl="/api" />
  </main>,
)
