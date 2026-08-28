import { validateProfileWrite, mapFixture } from './profile-utils.js';
const fixture = {
    remoteId: 'XHS-FIXTURE-2001', title: '轻云防晒外套 2026', description: '一件轻过盛夏，通勤与轻户外自在切换。',
    price: 169, stock: 1286,
    sku: [{ id: 'XHS-SKU-WHITE-S', name: '云白/S', price: 169, stock: 420 }],
    images: ['fixture://xiaohongshu/coat-1.jpg'], category: '服饰 > 外套',
    attributes: { material: '轻薄锦纶', upf: 'UPF50+', weight: '168g' },
    platformFields: { noteStatus: 'draft', contentType: '商品笔记' }, observedAt: '2026-08-22T00:00:00.000Z',
};
export const xiaohongshuProfile = {
    platform: 'xiaohongshu', schemaProfile: 'xiaohongshu.note.v1',
    requiredFields: ['title', 'category', 'price', 'stock'],
    writableFields: ['title', 'description', 'category', 'price', 'stock', 'images', 'attributes'],
    fixture, mapProduct: (raw, mapping) => mapFixture('xiaohongshu', raw, mapping.id),
    validateWrite: input => validateProfileWrite(xiaohongshuProfile, input),
};
//# sourceMappingURL=xiaohongshu.js.map