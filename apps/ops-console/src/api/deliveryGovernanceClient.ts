import { opsRestGet } from "./opsClient.js";

export const deliveryEvidenceStatuses = ["passed", "blocked", "unverified"] as const;
export type DeliveryEvidenceStatus = (typeof deliveryEvidenceStatuses)[number];

export interface DeliveryFinding {
  code: string;
  message: string;
  nextAction: string;
}

export interface MappingPreflightEvidence {
  id: string;
  platform: string;
  productId: string;
  status: DeliveryEvidenceStatus;
  findings: DeliveryFinding[];
}

export interface BundleVerificationEvidence {
  id: string;
  taskId: string;
  productId: string;
  status: DeliveryEvidenceStatus;
  findings: DeliveryFinding[];
  verification?: {
    valid: boolean;
    manifestHash: string;
    artifactSha256: string;
  };
}

export interface AuthenticityEvidence {
  id: string;
  jobId: string;
  productId: string;
  status: DeliveryEvidenceStatus;
  findings: DeliveryFinding[];
}

export interface DeliveryReadiness {
  generatedAt: string;
  status: DeliveryEvidenceStatus;
  dimensions: {
    mapping: DeliveryEvidenceStatus;
    bundles: DeliveryEvidenceStatus;
    authenticity: DeliveryEvidenceStatus;
  };
  mappingPreflights: MappingPreflightEvidence[];
  bundles: BundleVerificationEvidence[];
  authenticity: AuthenticityEvidence[];
}

export interface DeliveryGovernanceClient {
  get(signal?: AbortSignal): Promise<DeliveryReadiness | null>;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const status = (value: unknown): value is DeliveryEvidenceStatus => deliveryEvidenceStatuses.includes(value as DeliveryEvidenceStatus);
const finding = (value: unknown): value is DeliveryFinding => object(value) && text(value.code) && text(value.message) && text(value.nextAction);
const findings = (value: unknown): value is DeliveryFinding[] => Array.isArray(value) && value.every(finding);
const commonEvidence = (value: unknown): value is Record<string, unknown> & { id: string; status: DeliveryEvidenceStatus; findings: DeliveryFinding[] } => object(value) && text(value.id) && status(value.status) && findings(value.findings);
const mappingEvidence = (value: unknown): value is MappingPreflightEvidence => commonEvidence(value) && text(value.platform) && text(value.productId);
const bundleVerification = (value: unknown): value is { valid: boolean; manifestHash: string; artifactSha256: string } | undefined => value === undefined || (object(value) && typeof value.valid === "boolean" && text(value.manifestHash) && text(value.artifactSha256));
const bundleEvidence = (value: unknown): value is BundleVerificationEvidence => commonEvidence(value) && text(value.taskId) && text(value.productId) && bundleVerification(value.verification);
const authenticityEvidence = (value: unknown): value is AuthenticityEvidence => commonEvidence(value) && text(value.jobId) && text(value.productId);

export function parseDeliveryReadiness(value: unknown): DeliveryReadiness | null {
  if (value === null) return null;
  if (!object(value) || !text(value.generatedAt) || !status(value.status) || !object(value.dimensions))
    throw new Error("交付治理接口返回了无效响应（状态或时间）");
  const dimensions = value.dimensions;
  if (!status(dimensions.mapping) || !status(dimensions.bundles) || !status(dimensions.authenticity))
    throw new Error("交付治理接口返回了无效响应（dimensions）");
  if (!Array.isArray(value.mappingPreflights) || !value.mappingPreflights.every(mappingEvidence))
    throw new Error("交付治理接口返回了无效响应（mappingPreflights）");
  if (!Array.isArray(value.bundles) || !value.bundles.every(bundleEvidence))
    throw new Error("交付治理接口返回了无效响应（bundles）");
  if (!Array.isArray(value.authenticity) || !value.authenticity.every(authenticityEvidence))
    throw new Error("交付治理接口返回了无效响应（authenticity）");
  return value as unknown as DeliveryReadiness;
}

export const deliveryGovernanceClient: DeliveryGovernanceClient = {
  get: async (signal) => parseDeliveryReadiness(await opsRestGet<unknown>("/v1/delivery-readiness", { signal })),
};
