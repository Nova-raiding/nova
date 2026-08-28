import { validateProfileWrite, mapFixture } from './profile-utils.js'
import type { PlatformProfile } from '../types.js'

const fixture = {
  remoteId: 'PDD-FIXTURE-4001', title: '拼多多轻量防晒外套', description: '轻薄透气，日常防晒好搭配。', price: 129, stock: 2400,
  sku: [{ id: 'PDD-SKU-BLUE-L', name: '雾蓝/L', price: 129, stock: 1200 }], images: ['fixture://pinduoduo/coat-1.jpg'], category: '女装 > 外套',
  attributes: { material: '涤纶', upf: 'UPF40+' }, platformFields: { goodsId: 'goods-fixture', multiGroup: true }, observedAt: '2026-08-22T00:00:00.000Z',
}
export const pinduoduoProfile: PlatformProfile = {
  platform: 'pinduoduo', schemaProfile: 'pdd.goods.v1', requiredFields: ['title', 'category', 'price', 'stock'],
  writableFields: ['title', 'description', 'category', 'price', 'stock', 'images', 'attributes'], fixture,
  mapProduct: (raw, mapping) => mapFixture('pinduoduo', raw, mapping.id), validateWrite: (input) => validateProfileWrite(pinduoduoProfile, input),
}
