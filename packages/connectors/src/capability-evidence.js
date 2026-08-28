const order = ['unverified', 'documented', 'fixture_verified', 'test_e2e', 'production_canary'];
export function advanceCapabilityEvidence(current, next, proof = {}) {
    const currentIndex = order.indexOf(current.state);
    const nextIndex = order.indexOf(next);
    if (nextIndex < 0 || nextIndex > currentIndex + 1)
        throw new Error(`capability evidence cannot skip from ${current.state} to ${next}`);
    if (nextIndex > currentIndex && (!proof.evidenceRef || !proof.verifiedBy || !proof.verifiedAt))
        throw new Error('capability advancement requires evidenceRef, verifiedBy and verifiedAt');
    return { ...current, ...proof, state: next };
}
export function isProductionCanaryReady(evidence, platform) {
    const required = ['authorize', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload'];
    return required.every(capability => evidence.some(item => item.platform === platform && item.capability === capability && item.state === 'production_canary'));
}
//# sourceMappingURL=capability-evidence.js.map