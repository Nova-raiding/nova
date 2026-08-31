import { useState } from "react";
import { ApartmentOutlined, ShopOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Empty, Input, Select, Space, Tag, Typography } from "antd";
import type { BrandNavigationItem, StoreDirectory } from "../../types/ops.js";
import { OpsDataState } from "../../components/OpsDataState.js";

interface BrandTreeSectionProps {
  brands?: BrandNavigationItem[];
  canRead?: boolean;
  canCreate?: boolean;
  stores?: StoreDirectory[];
  canBind?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onOpenStore?: (platform: string, accountId: string) => void;
  onCreateBrand?: (name: string) => Promise<boolean> | boolean;
  onBindStore?: (input: { brandId: string; platform: string; accountId: string; expectedRevision?: number }) => Promise<boolean> | boolean;
}

export function BrandTreeSection({ brands = [], canRead = true, canCreate = false, stores = [], canBind = false, loading = false, error = "", onRetry, onOpenStore, onCreateBrand, onBindStore }: BrandTreeSectionProps) {
  const [brandName, setBrandName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [selectedStores, setSelectedStores] = useState<Record<string, string>>({});
  const [bindingBrandId, setBindingBrandId] = useState<string>();
  const [bindingErrorBrandId, setBindingErrorBrandId] = useState<string>();
  const [bindingError, setBindingError] = useState("");
  const submitCreate = async () => {
    const name = brandName.trim();
    if (!onCreateBrand || !name) {
      setCreateError("请输入品牌名称");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      if (await onCreateBrand(name)) setBrandName("");
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "创建品牌失败");
    } finally {
      setCreating(false);
    }
  };
  const bindStore = async (brand: BrandNavigationItem) => {
    const selected = selectedStores[brand.id];
    const [platform, accountId] = selected?.split(":", 2) ?? [];
    if (!onBindStore || !platform || !accountId) {
      setBindingErrorBrandId(brand.id);
      setBindingError("请选择一个真实可用的店铺");
      return;
    }
    setBindingBrandId(brand.id);
    setBindingErrorBrandId(undefined);
    setBindingError("");
    try {
      if (await onBindStore({ brandId: brand.id, platform, accountId, ...(brand.revision !== undefined ? { expectedRevision: brand.revision } : {}) })) setSelectedStores((current) => ({ ...current, [brand.id]: "" }));
    } catch (cause) {
      setBindingErrorBrandId(brand.id);
      setBindingError(cause instanceof Error ? cause.message : "绑定店铺失败");
    } finally {
      setBindingBrandId(undefined);
    }
  };
  return (
    <Card title={<Space><ApartmentOutlined aria-hidden="true" />品牌、平台与店铺</Space>}>
      {!canRead ? (
        <div className="ops-data-state" data-state="forbidden">
          <Alert role="alert" type="warning" showIcon message="当前账号无权读取品牌树" description="这不是空结果；服务端已按品牌访问权限隐藏品牌明细。请切换到已授权的工作区或联系管理员授予品牌读取权限。" />
        </div>
      ) : error ? (
        <OpsDataState state="error" title="品牌树读取失败" description={error} onRetry={onRetry} />
      ) : loading ? (
        <OpsDataState state="loading" description="正在读取品牌、平台与店铺" />
      ) : brands.length === 0 ? (
        <OpsDataState state="empty" description="当前工作区还没有可访问的品牌">
          {canCreate && onCreateBrand && <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Typography.Text>先创建一个品牌，再绑定平台和店铺。</Typography.Text>
            <Space.Compact style={{ maxWidth: 520, width: "100%" }}>
              <Input aria-label="品牌名称" value={brandName} onChange={(event) => setBrandName(event.target.value)} onPressEnter={() => void submitCreate()} placeholder="例如：山野户外" maxLength={120} />
              <Button type="primary" loading={creating} onClick={() => void submitCreate()}>创建品牌</Button>
            </Space.Compact>
            {createError && <Alert role="alert" type="error" showIcon message="创建品牌失败" description={createError} />}
          </Space>}
        </OpsDataState>
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
                    {platform.stores.map((store) => onOpenStore ? (
                      <Tag icon={<ShopOutlined />} key={store.id}>
                        <button className="brand-tree-store-link" type="button" onClick={() => onOpenStore(platform.platform, store.accountId)} aria-label={`查看${platform.title}店铺 ${store.accountId} 的任务`}>
                          {store.accountId}
                        </button>
                      </Tag>
                    ) : <Tag icon={<ShopOutlined />} key={store.id}>{store.accountId}</Tag>)}
                  </Space>
                </div>
              ))}
              {canBind && onBindStore && <Space direction="vertical" size={8} style={{ width: "100%", marginTop: 12 }}>
                <Typography.Text type="secondary">绑定已授权店铺</Typography.Text>
                <Space.Compact style={{ width: "100%" }}>
                  <Select aria-label={`${brand.title}待绑定店铺`} value={selectedStores[brand.id] || undefined} placeholder="选择平台店铺" style={{ flex: 1 }} options={stores.filter(store => store.readable && store.state !== "revoked" && !brand.platforms.some(platform => platform.platform === store.platform && platform.stores.some(bound => bound.accountId === store.accountId))).map(store => ({ value: `${store.platform}:${store.accountId}`, label: `${store.label}（${store.accountId}）` }))} onChange={(value) => setSelectedStores((current) => ({ ...current, [brand.id]: value }))} />
                  <Button type="primary" loading={bindingBrandId === brand.id} onClick={() => void bindStore(brand)}>绑定店铺</Button>
                </Space.Compact>
                {bindingError && bindingErrorBrandId === brand.id && <Alert role="alert" type="error" showIcon message="绑定店铺失败" description={bindingError} />}
              </Space>}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
