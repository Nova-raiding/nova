import { useSupportDomain } from "../../hooks/useSupportDomain.js";
import { SupportPage } from "../../pages/SupportPage.js";
import type { OpsDomainPageProps } from "../opsPageRegistry.js";

function WorkspaceSupportRoute({ model }: OpsDomainPageProps) {
  const supportModel = useSupportDomain(model.supportClient, model.opsWorkspaceId);
  return <SupportPage model={supportModel} />;
}

export function SupportRoute(props: OpsDomainPageProps) {
  return props.model.authorization.scope.kind === "platform" ? <SupportPage platformModel={props.model}/> : <WorkspaceSupportRoute {...props}/>;
}
