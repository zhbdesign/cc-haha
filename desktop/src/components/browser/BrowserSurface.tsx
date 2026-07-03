import { useEffect, useLayoutEffect, useRef } from 'react'
import { Camera, Loader2, Maximize2, Minus, MousePointer2, Plus, RotateCcw } from 'lucide-react'
import { BrowserAddressBar } from './BrowserAddressBar'
import { computeWebviewBounds } from './computeWebviewBounds'
import { getServerBaseUrl, isLoopbackHostname } from '../../lib/desktopRuntime'
import { classifyPreviewLink } from '../../lib/previewLinkRouter'
import { isAbsoluteLocalPath, localFileUrl, previewFsUrl } from '../../lib/handlePreviewLink'
import { previewBridge } from '../../lib/previewBridge'
import { subscribePreviewEvents } from '../../lib/previewEvents'
import {
  BROWSER_ZOOM_STEP,
  DEFAULT_BROWSER_ZOOM,
  MAX_BROWSER_ZOOM,
  MIN_BROWSER_ZOOM,
  normalizeBrowserZoom,
  useBrowserPanelStore,
} from '../../stores/browserPanelStore'
import { useOverlayStore } from '../../stores/overlayStore'
import { useTabStore } from '../../stores/tabStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { getDesktopHost } from '../../lib/desktopHost'

const LOCAL_PREVIEW_PATH_PREFIXES = ['/preview-fs/', '/local-file/']
const LOCAL_PREVIEW_READY_TIMEOUT_MS = 2500

function shouldWaitForLocalPreview(url: string): boolean {
  try {
    const parsed = new URL(url)
    return isLoopbackHostname(parsed.hostname) &&
      LOCAL_PREVIEW_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
  } catch {
    return false
  }
}

async function waitForLocalPreview(url: string): Promise<void> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), LOCAL_PREVIEW_READY_TIMEOUT_MS)
  try {
    await fetch(url, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch {
    // Best-effort warmup only. The native webview still navigates so users can
    // see the server's own error page or use Reload if the first probe raced.
  } finally {
    window.clearTimeout(timeout)
  }
}

function resolveBrowserNavigationUrl(input: string, sessionId: string): string {
  const value = input.trim()
  if (!value) return ''

  const classified = classifyPreviewLink(value)
  if (classified.kind === 'browser-file' && classified.path) {
    const serverBaseUrl = getServerBaseUrl()
    return isAbsoluteLocalPath(classified.path)
      ? localFileUrl(serverBaseUrl, classified.path)
      : previewFsUrl(serverBaseUrl, sessionId, classified.path)
  }

  return value
}

export function BrowserSurface({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const loadSeqRef = useRef(0)
  const requestedUrlRef = useRef<string | null>(null)
  const hasNativePreviewRef = useRef(false)
  const session = useBrowserPanelStore((s) => s.bySession[sessionId])
  const store = useBrowserPanelStore.getState()
  const overlayCount = useOverlayStore((s) => s.count)
  const previewZoom = session?.zoom ?? DEFAULT_BROWSER_ZOOM
  const zoomPercent = Math.round(previewZoom * 100)
  const canZoomOut = previewZoom > MIN_BROWSER_ZOOM
  const canZoomIn = previewZoom < MAX_BROWSER_ZOOM

  const reportBounds = () => {
    const el = hostRef.current
    if (!el) return
    previewBridge.setBounds(computeWebviewBounds(el.getBoundingClientRect()))
  }

  const loadNativePreview = (
    url: string,
    action: () => Promise<void>,
  ) => {
    const seq = loadSeqRef.current + 1
    loadSeqRef.current = seq
    void (async () => {
      if (shouldWaitForLocalPreview(url)) {
        await waitForLocalPreview(url)
      }
      if (loadSeqRef.current !== seq) return
      await action()
    })().catch(() => {
      if (loadSeqRef.current === seq) {
        if (requestedUrlRef.current === url) {
          requestedUrlRef.current = null
        }
        useBrowserPanelStore.getState().setLoading(sessionId, false)
      }
    })
  }

  const requestNativePreview = (url: string, options?: { force?: boolean }) => {
    if (!url) return
    if (!options?.force && requestedUrlRef.current === url) return

    requestedUrlRef.current = url
    loadNativePreview(url, async () => {
      await previewBridge.setZoom(previewZoom)
      if (hasNativePreviewRef.current) {
        await previewBridge.navigate(url)
        return
      }

      const el = hostRef.current
      hasNativePreviewRef.current = true
      if (el) {
        await previewBridge.open(url, computeWebviewBounds(el.getBoundingClientRect()))
      } else {
        await previewBridge.navigate(url)
      }
    })
  }

  useLayoutEffect(() => {
    if (session?.url) {
      requestNativePreview(session.url)
    }
    return () => {
      loadSeqRef.current += 1
      requestedUrlRef.current = null
      hasNativePreviewRef.current = false
      previewBridge.close()
    }
    // The visibility-sync effect below owns setVisible() — including the
    // initial reveal — so it always factors in overlayCount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (!session?.url || !session.loading) return
    requestNativePreview(session.url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.url, session?.loading, sessionId])

  // Visibility-sync: a fullscreen DOM overlay (e.g. ImageGalleryModal) would
  // otherwise be partially covered by the native child webview, which always
  // renders above the DOM. While overlayCount > 0 we hide the webview; when
  // it returns to 0 (and we're still mounted in browser mode) we re-show it.
  // The layout-effect teardown above still closes the webview on unmount.
  useEffect(() => {
    if (!session) return
    previewBridge.setVisible(overlayCount === 0)
  }, [overlayCount, session])

  useEffect(() => {
    if (!session) return
    void previewBridge.setZoom(previewZoom)
  }, [previewZoom, session])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => reportBounds())
    ro.observe(el)
    window.addEventListener('resize', reportBounds)
    return () => { ro.disconnect(); window.removeEventListener('resize', reportBounds) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    let unsub: (() => void) | undefined
    void subscribePreviewEvents(sessionId).then((u) => { unsub = u })
    return () => { unsub?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 兜底：navigated/ready 依赖注入脚本，若外站 CSP 拦截则永不回灌。loading 变 true 后 ~15s 强制收尾。
  const isLoading = session?.loading ?? false
  const currentUrl = session?.url
  useEffect(() => {
    if (!isLoading) return
    const timer = window.setTimeout(() => {
      useBrowserPanelStore.getState().setLoading(sessionId, false)
    }, 15000)
    return () => window.clearTimeout(timer)
  }, [isLoading, currentUrl, sessionId])

  if (!session) return null

  const openOrNavigate = (inputUrl: string) => {
    const url = resolveBrowserNavigationUrl(inputUrl, sessionId)
    if (!url) return
    store.navigate(sessionId, url)
    requestNativePreview(url)
  }

  const setPreviewZoom = (nextZoom: number) => {
    store.setZoom(sessionId, normalizeBrowserZoom(nextZoom))
  }

  const toolbarBtnClass = [
    'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
    'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-text-primary)]',
    'disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--color-text-secondary)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]',
  ].join(' ')

  const actionBtnClass = [
    'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
    'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-container-low)] hover:text-[var(--color-text-primary)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]',
  ].join(' ')

  // All toolbar actions live in the address bar area, which is ABOVE the
  // preview-host div. This ensures they are never covered by the native
  // WebContentsView (which always renders above DOM content in Electron).
  const toolbarActions = (
    <>
      <div
        data-testid="browser-zoom-controls"
        className="inline-flex h-7 items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1"
      >
        <button
          aria-label="缩小预览"
          title="缩小预览"
          disabled={!canZoomOut}
          className={toolbarBtnClass}
          onClick={() => setPreviewZoom(previewZoom - BROWSER_ZOOM_STEP)}
        >
          <Minus size={13} />
        </button>
        <span className="min-w-[36px] select-none text-center text-[11px] font-medium tabular-nums text-[var(--color-text-secondary)]">
          {zoomPercent}%
        </span>
        <button
          aria-label="放大预览"
          title="放大预览"
          disabled={!canZoomIn}
          className={toolbarBtnClass}
          onClick={() => setPreviewZoom(previewZoom + BROWSER_ZOOM_STEP)}
        >
          <Plus size={13} />
        </button>
        {previewZoom !== DEFAULT_BROWSER_ZOOM && (
          <button
            aria-label="重置预览缩放"
            title="重置预览缩放"
            className={toolbarBtnClass}
            onClick={() => setPreviewZoom(DEFAULT_BROWSER_ZOOM)}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      <button
        aria-label="截图"
        title="截图"
        className={actionBtnClass}
        onClick={() => previewBridge.message({ v: 1, type: 'capture', kind: 'full' })}
      >
        <Camera size={14} />
      </button>
      <button
        aria-label="选择元素"
        aria-pressed={Boolean(session.pickerActive)}
        title="选择元素"
        className={[
          actionBtnClass,
          session.pickerActive
            ? 'bg-[var(--color-surface-selected)] text-[var(--color-brand)]'
            : '',
        ].join(' ')}
        onClick={() => {
          const cur = useBrowserPanelStore.getState().bySession[sessionId]
          const next = !cur?.pickerActive
          store.setPicker(sessionId, next)
          previewBridge.message({ v: 1, type: next ? 'enter-picker' : 'exit-picker' })
        }}
      >
        <MousePointer2 size={14} />
      </button>
      {getDesktopHost().capabilities.previewWebview && (
        <button
          aria-label="展开为完整浏览器"
          title="展开为完整浏览器"
          className={actionBtnClass}
          onClick={() => {
            const tabStore = useTabStore.getState()
            const workspaceStore = useWorkspacePanelStore.getState()
            workspaceStore.setMode(sessionId, 'browser')
            tabStore.openWorkbenchTab(sessionId)
            workspaceStore.closePanel(sessionId)
          }}
        >
          <Maximize2 size={14} />
        </button>
      )}
    </>
  )

  return (
    <div className="flex h-full flex-col">
      <BrowserAddressBar
        url={session.url}
        canGoBack={session.canGoBack}
        canGoForward={session.canGoForward}
        loading={session.loading}
        onNavigate={openOrNavigate}
        onBack={() => {
          store.goBack(sessionId)
          store.setLoading(sessionId, true)
          const url = useBrowserPanelStore.getState().bySession[sessionId]!.url
          requestNativePreview(url)
        }}
        onForward={() => {
          store.goForward(sessionId)
          store.setLoading(sessionId, true)
          const url = useBrowserPanelStore.getState().bySession[sessionId]!.url
          requestNativePreview(url)
        }}
        onReload={() => {
          if (!session.url) return
          store.setLoading(sessionId, true)
          requestNativePreview(session.url, { force: true })
        }}
        rightActions={toolbarActions}
      />
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-[var(--color-surface)]" data-testid="preview-host">
          {session.loading && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--color-surface)] text-[var(--color-text-tertiary)]">
              <Loader2 size={18} className="animate-spin" aria-label="加载中" />
            </div>
          )}
      </div>
    </div>
  )
}
