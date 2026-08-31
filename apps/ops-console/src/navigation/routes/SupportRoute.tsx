import { useSupportDomain } from "../../hooks/useSupportDomain.js";
import { SupportPage } from "../../pages/SupportPage.js";
import type { OpsDomainPageProps } from "../opsPageRegistry.js";

export function SupportRoute({ model }: OpsDomainPageProps) {
  const supportModel = useSupportDomain(model.supportClient, model.opsWorkspaceId, model.authorization.scope.kind === "platform");
  return <SupportPage model={supportModel} />;
}
