import { type RelayUsageContext, type RelayUsageSink } from './relay-usage.js';
export interface ImageGenerationInput {
    productTitle: string;
    category?: string;
    direction: string;
    count: number;
    /** Product references used for image-to-image/edit generation. */
    sourceImageUrls?: string[];
    /** Workspace-scoped uploaded asset references resolved by the model relay. */
    sourceAssetRefs?: string[];
    /** Whether to create a new concept or optimize the supplied product assets. */
    mode?: 'create' | 'optimize';
    usageContext?: RelayUsageContext;
}
export interface ImageGenerator {
    generate(input: ImageGenerationInput): Promise<string[]>;
}
export interface OpenAICompatibleImageGeneratorOptions {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs?: number;
    size?: string;
    quality?: string;
    outputFormat?: 'png' | 'jpeg' | 'webp';
    responseFormat?: 'url' | 'b64_json';
    fetch?: typeof fetch;
    usageSink?: RelayUsageSink;
}
export declare class OpenAICompatibleImageGenerator implements ImageGenerator {
    private readonly options;
    private readonly fetchImpl;
    constructor(options: OpenAICompatibleImageGeneratorOptions);
    generate(input: ImageGenerationInput): Promise<string[]>;
}
export declare function createImageGeneratorFromEnv(source?: Record<string, string | undefined>, usageSink?: RelayUsageSink): ImageGenerator | undefined;
//# sourceMappingURL=image-generator.d.ts.map