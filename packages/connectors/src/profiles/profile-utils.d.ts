import type { PlatformProfile, PlatformWriteDraft, RawProduct, ValidationFinding } from '../types.js';
export declare function validateProfileWrite(profile: PlatformProfile, input: PlatformWriteDraft): ValidationFinding[];
export declare function mapFixture(platform: PlatformProfile['platform'], raw: RawProduct, mappingVersion: string): {
    platform: import("../types.js").Platform;
    remoteId: string;
    title: string;
    description: string;
    price: number;
    stock: number;
    sku: {
        id: string;
        name: string;
        price: number;
        stock: number;
    }[];
    images: string[];
    category: string;
    facts: {
        stock: number;
        price: number;
    };
    mappingVersion: string;
    source: "fixture";
    listingStatus: "on_sale" | "off_sale" | "draft" | "unknown";
    platformUpdatedAt: string;
    rawPlatformFields: {
        [k: string]: string | number | boolean | null;
    };
};
//# sourceMappingURL=profile-utils.d.ts.map