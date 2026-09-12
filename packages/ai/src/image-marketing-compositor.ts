import { createCanvas, loadImage } from '@napi-rs/canvas'

export interface MarketingCompositorBrief {
  productTitle: string
  sellingPoints?: string[]
  trafficKeywords?: string[]
  promotionLabels?: string[]
  marketingLabels?: string[]
  headline?: string
  subheadline?: string
  cta?: string
  logoAssetIds?: string[]
}

function trace(event: string, fields: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV === 'production' && process.env.MERCHANT_IMAGE_TRACE_LOGS !== 'true') return
  try { console.info(JSON.stringify({ event: `merchant.image.compositor.${event}`, ts: new Date().toISOString(), ...fields })) } catch { /* diagnostics must never affect generation */ }
}

function clean(values: Array<string | undefined>, max: number, excluded: string[] = []) {
  const excludedValues = new Set(excluded.map(value => value.trim()).filter(Boolean))
  return [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value)))]
    .filter(value => !excludedValues.has(value))
    .slice(0, max)
}

async function resolveImageSource(source: string, fetchImpl: typeof fetch): Promise<string> {
  if (/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/iu.test(source)) return source
  if (!/^https:\/\//iu.test(source)) throw new Error('marketing compositor requires a data-url or HTTPS image')
  const response = await fetchImpl(source, { method: 'GET', headers: { accept: 'image/png,image/jpeg,image/webp' }, redirect: 'error' })
  if (!response.ok) throw new Error(`marketing compositor image fetch failed with HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType ?? '')) throw new Error('marketing compositor received a non-image response')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > 32 * 1024 * 1024) throw new Error('marketing compositor image response is empty or too large')
  return `data:${contentType};base64,${bytes.toString('base64')}`
}

function wrapToWidth(context: { measureText(value: string): { width: number } }, text: string, maxWidth: number) {
  const chars = [...text.trim()]
  const lines: string[] = []
  let line = ''
  for (const char of chars) {
    const candidate = `${line}${char}`
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line)
      line = char
    } else line = candidate
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

/**
 * Adds exact, confirmed copy after the image model has finished. Image models
 * are deliberately instructed not to render copy because generated Chinese
 * glyphs are not reliable enough for a merchant-facing asset.
 */
export async function composeMarketingImages(images: string[], brief: MarketingCompositorBrief, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const title = brief.productTitle.trim()
  if (!title) throw new Error('marketing compositor requires a product title')
  const headline = brief.headline?.trim() || title
  const promotionLabels = clean(brief.promotionLabels ?? [], 2)
  const labels = clean([
    ...brief.sellingPoints ?? [],
    ...brief.trafficKeywords ?? [],
    ...brief.marketingLabels ?? [],
  ], 4, [title, headline, ...promotionLabels])
  const subheadline = brief.subheadline?.trim()
  const cta = brief.cta?.trim()
  trace('request', { image_count: images.length, label_count: labels.length, logo_asset_count: brief.logoAssetIds?.length ?? 0, has_headline: Boolean(headline), has_subheadline: Boolean(subheadline), has_cta: Boolean(cta) })
  try {
    const output: string[] = []
    for (const [index, source] of images.entries()) {
      const resolvedSource = await resolveImageSource(source, fetchImpl)
      const image = await loadImage(Buffer.from(resolvedSource.slice(resolvedSource.indexOf(',') + 1), 'base64'))
      const width = image.width
      const height = image.height
      const canvas = createCanvas(width, height)
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0, width, height)

      // A restrained left rail creates a real listing composition without
      // covering the product. It is intentionally opaque enough for exact
      // text to remain readable over varied model backgrounds.
      const railWidth = Math.max(320, Math.round(width * 0.38))
      const padding = Math.max(28, Math.round(width * 0.035))
      const textWidth = railWidth - padding * 1.35
      // Keep this opaque. Provider outputs can still hallucinate tiny text;
      // a translucent rail would leak it through the approved copy layer.
      context.fillStyle = '#0c141e'
      context.fillRect(0, 0, railWidth + padding, height)

      context.textBaseline = 'top'
      const headlineSize = Math.max(34, Math.round(width * 0.042))
      const headlineLineHeight = Math.round(headlineSize * 1.25)
      context.font = `700 ${headlineSize}px "Noto Sans CJK SC", sans-serif`
      context.fillStyle = '#ffffff'
      const headlineLines = wrapToWidth(context, headline, textWidth).slice(0, 3)
      for (const [lineIndex, line] of headlineLines.entries()) context.fillText(line, padding, padding + lineIndex * headlineLineHeight)

      let cursorY = padding + headlineLines.length * headlineLineHeight + Math.max(28, Math.round(width * 0.03))
      if (subheadline) {
        context.font = `500 ${Math.max(20, Math.round(width * 0.026))}px "Noto Sans CJK SC", sans-serif`
        context.fillStyle = 'rgba(255,255,255,0.9)'
        for (const line of wrapToWidth(context, subheadline, textWidth).slice(0, 2)) { context.fillText(line, padding, cursorY); cursorY += Math.max(28, Math.round(width * 0.035)) }
        cursorY += 16
      }
      context.font = `600 ${Math.max(19, Math.round(width * 0.022))}px "Noto Sans CJK SC", sans-serif`
      for (const label of labels) {
        const labelText = `· ${label}`
        const lines = wrapToWidth(context, labelText, textWidth).slice(0, 2)
        context.fillStyle = 'rgba(255,255,255,0.94)'
        for (const line of lines) { context.fillText(line, padding, cursorY); cursorY += Math.max(26, Math.round(width * 0.031)) }
        cursorY += 8
      }
      if (promotionLabels.length) {
        context.fillStyle = '#ff5a36'
        context.fillRect(padding, Math.min(height - 110, cursorY + 8), Math.min(railWidth - padding * 2, 220), 52)
        context.fillStyle = '#ffffff'
        context.font = `700 ${Math.max(19, Math.round(width * 0.022))}px "Noto Sans CJK SC", sans-serif`
        context.fillText(promotionLabels[0]!, padding + 14, Math.min(height - 100, cursorY + 22))
      } else if (cta) {
        context.strokeStyle = 'rgba(255,255,255,0.85)'
        context.lineWidth = 2
        context.strokeRect(padding, Math.min(height - 90, cursorY + 8), Math.min(railWidth - padding * 2, 200), 48)
        context.fillStyle = '#ffffff'
        context.fillText(cta, padding + 14, Math.min(height - 80, cursorY + 20))
      }
      // The worker returns generated artifacts through the result API. WebP
      // keeps merchant-facing text crisp while staying below that API's
      // bounded request size; uncompressed PNG can exceed it after overlays.
      const encoded = canvas.toBuffer('image/webp', 88)
      output.push(`data:image/webp;base64,${encoded.toString('base64')}`)
      trace('result', { index, width, height, format: 'webp', encoded_bytes: encoded.length, output_bytes: output[index]!.length })
    }
    return output
  } catch (error) {
    trace('error', { message: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
