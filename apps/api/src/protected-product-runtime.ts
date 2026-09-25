import { DomainError } from '../../../packages/application/src/service.js'
import { validateProtectedProductIntent, type ProtectedProductIntentValidation } from '../../../packages/application/src/protected-product-intent.js'

const protectedProductPromptConstraints = validateProtectedProductIntent('').promptConstraints

export function appendProtectedProductConstraints(prompt: string) {
  return `${prompt.trim()}\n\n不可变商品约束（必须逐条遵守）：\n${protectedProductPromptConstraints.zh}\n\nImmutable product constraints (must all be followed):\n${protectedProductPromptConstraints.en}`
}

export function protectedProductConclusion(validation: ProtectedProductIntentValidation) {
  return {
    policy: 'protected-product-intent-v1',
    allowed: validation.allowed,
    immutableAttributes: validation.immutableConstraints.map(item => item.attribute),
    safeModifications: validation.safeModifications.map(item => item.category),
    blockedAttributes: [...new Set(validation.findings.map(item => item.attribute))],
    findingCodes: validation.findings.map(item => item.code),
  }
}

export function requireProtectedProductIntent(prompt: string) {
  const validation = validateProtectedProductIntent(prompt)
  if (!validation.allowed) {
    throw new DomainError('PROTECTED_PRODUCT_MUTATION_BLOCKED', '图片请求会改变受保护的商品事实，仅允许调整背景、场景、光影或构图', 409, {
      product_protection: protectedProductConclusion(validation),
    })
  }
  return validation
}
