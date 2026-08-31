import { IncidentsPage } from "../../pages/IncidentsPage.js";
import type { OpsDomainPageProps } from "../opsPageRegistry.js";

export function IncidentsRoute({ model }: OpsDomainPageProps) {
  return <IncidentsPage client={model.incidentsClient} authorization={model.authorization} />;
}
