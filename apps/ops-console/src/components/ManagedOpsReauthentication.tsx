import { Button, Card, Typography } from "antd";
import { storeNovaLogoUrl } from "../assets.js";

/**
 * Recovery surface for a managed (OIDC) deployment whose ops session is gone.
 *
 * Under `OPS_AUTH_MODE === "oidc"` the server builds the ops principal only from
 * the gateway's signed `x-oidc-*` headers (`authenticateOidcGateway`) and never
 * reads the password cookie. Showing the account/password page here therefore
 * accepted a submission, reported success, and bounced the operator straight
 * back to this state with no diagnosis and no way to re-authenticate. A full
 * page load is the re-authentication, because it is the gateway — not this
 * console — that challenges the operator.
 *
 * This lives beside `PlatformOpsLoginPage` rather than inside
 * `OpsConsoleController` because `tests/ops-component-architecture.test.ts`
 * keeps the controller composition-only: it must not carry page markup
 * (`Card` / `Table` / `Form` / `Descriptions`). Inlining this component there
 * failed that gate, which is the gate doing its job.
 */
export function ManagedOpsReauthentication({ detail, loading, onReauthenticate }: {
  detail?: string;
  loading?: boolean;
  onReauthenticate?: () => void;
}) {
  return (
    <main className="ops-login-page" aria-labelledby="ops-sso-reauth-title">
      <section className="ops-login-form-panel">
        <Card className="ops-login-card" variant="borderless">
          <div className="ops-login-card-heading">
            <Typography.Title id="ops-sso-reauth-title" level={2}>组织 SSO 会话已失效</Typography.Title>
            <Typography.Paragraph type="secondary">
              当前部署使用组织 SSO 认证，平台运营控制台不提供账号密码登录。
            </Typography.Paragraph>
          </div>
          <Typography.Paragraph>
            请通过组织登录入口重新完成认证，再回到本页继续运营操作。若重新认证后仍停留在此页，请联系平台管理员检查网关会话。
          </Typography.Paragraph>
          <Button type="primary" size="large" block style={{ minHeight: 44 }} loading={loading} disabled={!onReauthenticate} onClick={onReauthenticate}>
            {onReauthenticate ? "重新登录组织账号" : "组织登录入口未配置"}
          </Button>
          {!onReauthenticate ? (
            <Typography.Paragraph type="danger" role="alert">
              当前发布未配置可验证的组织 SSO 登录地址，请联系平台管理员修复发布配置。
            </Typography.Paragraph>
          ) : null}
          {detail ? (
            <details>
              <summary>查看失败详情（供管理员排查）</summary>
              <p>{detail}</p>
            </details>
          ) : null}
          <div className="ops-login-footer" aria-label="Store Nova">
            <img src={storeNovaLogoUrl} alt="Store Nova" />
          </div>
        </Card>
      </section>
    </main>
  );
}
