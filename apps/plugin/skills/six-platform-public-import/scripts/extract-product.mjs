#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const html = file ? readFileSync(file, 'utf8') : await new Promise(resolve => {
  let value = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { value += chunk })
  process.stdin.on('end', () => resolve(value))
})

const text = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
const first = (...values) => values.map(text).find(Boolean) ?? null
const metas = new Map()
for (const match of html.matchAll(/<meta\b[^>]*?(?:name|property)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*>/giu)) metas.set(match[1].toLowerCase(), text(match[2]))
const jsonLd = []
for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
  try { jsonLd.push(JSON.parse(match[1].replace(/<!--|-->/gu, '').trim())) } catch { /* malformed JSON-LD is non-fatal */ }
}
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(flatten)] : []
const product = flatten(jsonLd).find(item => {
  const type = item?.['@type']
  return type === 'Product' || (Array.isArray(type) && type.includes('Product'))
}) ?? {}
const offer = Array.isArray(product.offers) ? product.offers[0] ?? {} : product.offers ?? {}
const imageValues = Array.isArray(product.image) ? product.image : product.image ? [product.image] : []
const images = [...new Set(imageValues.map(text).filter(Boolean))]
const price = first(offer.price, offer.lowPrice, product.price, metas.get('product:price:amount'))
const result = {
  title: first(product.name, metas.get('og:title'), metas.get('twitter:title'), (html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu) ?? [])[1]),
  description: first(product.description, metas.get('description'), metas.get('og:description')),
  brand: first(typeof product.brand === 'object' ? product.brand.name : product.brand),
  sku: first(product.sku, product.mpn, product.productID),
  price: price ? Number.isFinite(Number(price)) ? Number(price).toFixed(2) : price : null,
  currency: first(offer.priceCurrency, metas.get('product:price:currency')),
  availability: first(offer.availability),
  images,
  sourceEvidence: {
    title: Boolean(product.name || metas.get('og:title')),
    description: Boolean(product.description || metas.get('description') || metas.get('og:description')),
    price: Boolean(price),
    images: images.length > 0,
    structuredData: jsonLd.length > 0,
  },
}
console.log(JSON.stringify(result, null, 2))
