import { ApartmentOutlined, ShopOutlined } from "@ant-design/icons";
import { Card, Empty, Space, Tag, Typography } from "antd";
import type { BrandNavigationItem } from "../../types/ops.js";

export function BrandTreeSection({ brands }: { brands: BrandNavigationItem[] }) {
  return (
    <Card title={<Space><ApartmentOutlined />品、平台与店铺</Space>}>
      {brands.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前工作区还没有可访问的品" />
      ) : (
        <div className="brand-tree-grid">
          {brands.map((brand) => (
            <section className="brand-tree-card" key={brand.id}>
              <Typography.Title level={5}>{brand.title}</Typography.Title>
              <Typography.Text type="secondary">{brand.id}</Typography.Text>
              {brand.platforms.map((platform) => (
                <div className="brand-tree-platform" key={platform.id}>
                  <Tag color="blue">{platform.title}</Tag>
                  <Space size={[4, 4]} wrap>
                    {platform.stores.map((store) => <Tag icon={<ShopOutlined />} key={store.id}>{store.accountId}</Tag>)}
                  </Space>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
