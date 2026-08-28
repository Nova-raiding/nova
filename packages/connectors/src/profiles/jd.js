import { validateProfileWrite, mapFixture } from './profile-utils.js';
const fixture = {
    remoteId: 'JD-FIXTURE-1001', title: '京选轻量防晒外套', description: '轻量防晒，适合通勤与轻户外。', price: 199, stock: 860,
    sku: [{ id: 'JD-SKU-BLACK-M', name: '黑色/M', price: 199, stock: 300 }], images: ['fixture://jd/coat-1.jpg'], category: '服饰 > 外套',
    attributes: { material: '锦纶', upf: 'UPF50+' }, platformFields: { jdCategoryId: '1315', wareStatus: 'ON_SALE' }, observedAt: '2026-08-22T00:00:00.000Z',
};
export const jdProfile = {
    platform: 'jd', schemaProfile: 'jd.product.v1', requiredFields: ['title', 'category', 'price', 'stock'],
    writableFields: ['title', 'description', 'category', 'price', 'stock', 'images', 'attributes'], fixture,
    mapProduct: (raw, mapping) => mapFixture('jd', raw, mapping.id), validateWrite: (input) => validateProfileWrite(jdProfile, input),
};
//# sourceMappingURL=jd.js.map