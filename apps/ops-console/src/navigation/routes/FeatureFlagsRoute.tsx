import { FeatureFlagsPage } from "../../pages/FeatureFlagsPage.js";
import type { OpsDomainPageProps } from "../opsPageRegistry.js";

export function FeatureFlagsRoute({ model }: OpsDomainPageProps) {
  return (
    <FeatureFlagsPage
      client={model.featureFlagsClient}
      canWrite={model.canWriteFeatureFlags}
      canEmergency={model.canEmergencyFeatureFlags}
    />
  );
}
