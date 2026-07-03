export type WebviewBounds = { x: number; y: number; width: number; height: number }

/**
 * Convert a renderer DOMRect (in zoomed CSS coordinates) to logical DIP
 * coordinates for `WebContentsView.setBounds()`.
 *
 * `getBoundingClientRect()` returns coordinates in the renderer's zoomed
 * coordinate space. When `webContents.setZoomFactor(z)` or
 * `body.style.zoom = z` is applied, all returned values are scaled by `z`.
 * But `WebContentsView.setBounds()` expects unzoomed DIP (logical) pixels
 * relative to the parent window. Dividing by `zoomFactor` converts from
 * the zoomed renderer coordinate space back to DIP coordinates.
 */
export function computeWebviewBounds(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  zoomFactor: number = 1,
): WebviewBounds {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return {
    x: Math.round(rect.left / z),
    y: Math.round(rect.top / z),
    width: Math.max(0, Math.round(rect.width / z)),
    height: Math.max(0, Math.round(rect.height / z)),
  }
}
