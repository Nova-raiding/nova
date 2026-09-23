import type { BridgeBJournal } from './ecs-bridge-b-transition.mjs';
export function initializeBridgeBJournal(filePath: string, signedSnapshot: BridgeBJournal, publicPem: string, now?: Date): Promise<BridgeBJournal>;
export function consumeBridgeBJournalNonce(filePath: string, deploymentNonce: string, privatePem: string, publicPem: string, now?: Date): Promise<BridgeBJournal>;
export function advanceBridgeBJournal(filePath: string, expectedPhase: string, nextPhase: string, privatePem: string, publicPem: string, now?: Date): Promise<BridgeBJournal>;
