import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlatformSummarySection, summarizePlatforms } from './PlatformSummarySection.js';
import { StoreDirectorySection } from './StoreDirectorySection.js';

describe('platform summary aggregate counts', () => {
  it('counts all stores represented by one redacted API group', () => {
    const stores = [{
      platform: 'taobao' as const,
      accountId: 'platform-aggregate:taobao:connected:official_api',
      label: '5 个淘宝店铺',
      state: 'connected',
      dataMode: 'official_api',
      readable: true,
      writeEnabled: false,
      revision: 0,
      aggregate: true,
      count: 5,
    }];

    expect(summarizePlatforms(stores)).toEqual([{ platform: 'taobao', storeCount: 5, officialApiCount: 5, attentionCount: 0 }]);
    const markup = renderToStaticMarkup(<PlatformSummarySection stores={stores} platformLabels={{ taobao: '淘宝' }} />);
    expect(markup).toContain('登记店铺');
    expect(markup).toContain('>5<');
    expect(markup).not.toContain('platform-aggregate:');

    const directoryMarkup = renderToStaticMarkup(<StoreDirectorySection storeDirectory={stores} canPlatformOps onSaveAlias={async () => true} onRevoke={async () => undefined} />);
    expect(directoryMarkup).toContain('5 个已登记店铺');
    expect(directoryMarkup).toContain('共 1 个平台汇总组');
    expect(directoryMarkup).toContain('5 个淘宝店铺');
  });
});
