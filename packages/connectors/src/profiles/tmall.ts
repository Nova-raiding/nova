import { validateProfileWrite, mapFixture } from './profile-utils.js'
import type { PlatformProfile } from '../types.js'

const fixture = {
  remoteId: 'TM-FIXTURE-3001', title: '轻云防晒外套｜旗舰店', description: '旗舰店商品详情示例，保留天猫独有品牌字段。', price: 219, stock: 520,
  sku: [{ id: 'TM-SKU-BLACK-M', name: '曜石黑/M', price: 219, stock: 520 }], images: ['fixture://tmall/coat-1.jpg'], category: '女装 > 风衣',
  attributes: { material: '锦纶', upf: 'UPF50+', brand: '云朵轻户外' }, platformFields: { brandId: 'brand-fixture', channel: 'tmall_flagship' }, observedAt: '2026-08-22T00:00:00.000Z',
}
export const tmallProfile: PlatformProfile = {
  platform: 'tmall', schemaProfile: 'tmall.item.v1', requiredFields: ['title', 'category', 'price', 'stock'],
  writableFields: ['title', 'description', 'category', 'price', 'stock', 'images', 'attributes'], fixture,
  mapProduct: (raw, mapping) => mapFixture('tmall', raw, mapping.id), validateWrite: (input) => validateProfileWrite(tmallProfile, input),
}
