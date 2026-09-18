import { DomainError } from '../../../packages/application/src/service.js'
import { isValidCustomerDeliveryContractRef } from '../../../packages/persistence/src/customer-delivery-repository.js'

function invalid(message: string): never {
  throw new DomainError('INVALID_REQUEST', message, 400)
}

/** Inspect parsed JSON before normalization or storage. PostgreSQL TEXT and
 * JSONB cannot represent U+0000 in either values or object keys. Use an
 * iterative walk so deeply nested, otherwise valid JSON cannot overflow the
 * call stack. This does not impose new field lengths or discard draft data. */
export function validateCustomerDeliveryJsonNoNul(value: unknown, label = '客户交付 JSON'): void {
  const pending: unknown[] = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (current.includes('\u0000')) invalid(`${label}不能包含空字符`)
    } else if (current !== null && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (key.includes('\u0000')) invalid(`${label}不能包含空字符`)
        pending.push(child)
      }
    }
  }
}

function calendarDate(value: string): boolean {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const instant = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === value
}

function zonedTimestamp(value: string): boolean {
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value)
  return Boolean(parts && calendarDate(parts[1]!) && Number(parts[2]) <= 23
    && Number(parts[3]) <= 59 && Number(parts[4]) <= 59
    // PostgreSQL rejects offsets beyond 15:59 (SQLSTATE 22009), even though
    // Date.parse accepts them. Keep both persistence adapters on one boundary.
    && (parts[5] === 'Z' || Number(parts[6]) <= 15 && Number(parts[7]) <= 59)
    && Number.isFinite(Date.parse(value)))
}

/** Validate before the storage adapter: malformed values must not become a
 * Memory-only business state, a TypeError, or a PostgreSQL conversion error.
 * Nullable draft fields are allowed; completion and scanned-asset requirements
 * remain the responsibility of the existing business/evidence gates. */
export function validateCustomerDeliveryProfileValues(patch: Record<string, unknown>): void {
  validateCustomerDeliveryJsonNoNul(patch, '客户档案')
  if (Object.hasOwn(patch, 'companyName') && (typeof patch.companyName !== 'string' || !patch.companyName.trim())) {
    invalid('公司名称必须是非空字符串')
  }
  // Keep edit requests within the same wire limit as customer-delivery.create.
  if (typeof patch.companyName === 'string' && patch.companyName.length > 200) invalid('公司名称最多为 200 个字符')
  for (const [key, label] of [['contractNumber', '合同编号'], ['projectOwner', '项目负责人'], ['supportOwner', '售后负责人']] as const) {
    if (Object.hasOwn(patch, key) && patch[key] !== null && typeof patch[key] !== 'string') invalid(`${label}必须是字符串或 null`)
  }
  if (Object.hasOwn(patch, 'paymentStatus') && !['paid', 'unpaid'].includes(patch.paymentStatus as string)) invalid('付款状态只能是 paid 或 unpaid')
  if (Object.hasOwn(patch, 'customerProfileStatus') && !['complete', 'incomplete'].includes(patch.customerProfileStatus as string)) invalid('客户档案状态只能是 complete 或 incomplete')
  if (Object.hasOwn(patch, 'contractRef') && patch.contractRef !== null
    && (typeof patch.contractRef !== 'string' || !isValidCustomerDeliveryContractRef(patch.contractRef))) invalid('合同必须是已上传并扫描通过的素材引用或 null')
  if (Object.hasOwn(patch, 'paymentDate') && patch.paymentDate !== null
    && (typeof patch.paymentDate !== 'string' || !calendarDate(patch.paymentDate))) invalid('付款日期必须是有效的 YYYY-MM-DD 日期或 null')
  if (Object.hasOwn(patch, 'plannedGoLiveAt') && patch.plannedGoLiveAt !== null
    && (typeof patch.plannedGoLiveAt !== 'string' || !zonedTimestamp(patch.plannedGoLiveAt))) invalid('要求上线时间必须是包含时区的有效 ISO 日期时间或 null')
  if (Object.hasOwn(patch, 'archivedAt') && patch.archivedAt !== null
    && (typeof patch.archivedAt !== 'string' || !zonedTimestamp(patch.archivedAt))) invalid('停用时间必须是包含时区的有效 ISO 日期时间或 null')
}
