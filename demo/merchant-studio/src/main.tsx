import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

type AppErrorBoundaryState = { hasError: boolean }

class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false }
  crashRecoveryRef = React.createRef<HTMLElement>()

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('Merchant Studio render failure; task state remains unconfirmed.', error)
  }

  componentDidUpdate(_: React.PropsWithChildren, previousState: AppErrorBoundaryState) {
    if (!previousState.hasError && this.state.hasError) {
      window.requestAnimationFrame(() => this.crashRecoveryRef.current?.focus({ preventScroll: true }))
    }
  }

  reload = () => window.location.reload()

  backToProducts = () => {
    window.history.pushState(null, '', '/merchant/products')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return <main ref={this.crashRecoveryRef} className="app-crash-recovery" role="alert" tabIndex={-1} aria-labelledby="app-crash-title" aria-describedby="app-crash-description">
      <div className="app-crash-card">
        <span className="section-kicker">WORKSPACE RECOVERY</span>
        <h1 id="app-crash-title">页面暂时无法显示</h1>
        <p id="app-crash-description">当前任务状态没有被确认，已有服务端数据不会被当作成功。可以重新加载；如果仍失败，请回到商品范围重新选择。</p>
        <div className="button-row">
          <button type="button" className="primary" onClick={this.reload}>重新加载</button>
          <button type="button" className="secondary" onClick={this.backToProducts}>回到商品与素材</button>
        </div>
      </div>
    </main>
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
)
