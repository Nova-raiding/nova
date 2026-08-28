import { validateProfileWrite, mapFixture } from './profile-utils.js';
const fixture = {
    remoteId: 'TB-FIXTURE-2001', title: '轻云防晒外套 2026', description: '一件轻过盛夏，通勤与轻户外自在切换。', price: 169, stock: 1286,
    sku: [{ id: 'TB-SKU-WHITE-S', name: '云白/S', price: 169, stock: 420 }, { id: 'TB-SKU-BLUE-M', name: '雾蓝/M', price: 169, stock: 866 }], images: ['fixture://taobao/coat-1.jpg'], category: '女装 > 外套',
    attributes: { material: '轻薄锦纶', upf: 'UPF50+', weight: '168g' }, platformFields: { sellerNick: 'fixture-shop', auctionStatus: 'onsale' }, observedAt: '2026-08-22T00:00:00.000Z',
};
export const taobaoProfile = {
    platform: 'taobao', schemaProfile: 'taobao.item.v1', requiredFields: ['title', 'category', 'price', 'stock'],
    writableFields: ['title', 'description', 'category', 'price', 'stock', 'images', 'attributes'], fixture,
    mapProduct: (raw, mapping) => mapFixture('taobao', raw, mapping.id), validateWrite: (input) => validateProfileWrite(taobaoProfile, input),
};
//# sourceMappingURL=taobao.js.map