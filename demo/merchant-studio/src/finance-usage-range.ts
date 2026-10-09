export type FinanceUsageRangeMode = 'day' | 'month'

export type FinanceUsageRange = {
  mode: FinanceUsageRangeMode
  start: string
  end: string
}

export type FinanceUsageRangeState = {
  draft: FinanceUsageRange
  applied: FinanceUsageRange
}

export type FinanceUsageRangeAction =
  | { type: 'set-mode'; mode: FinanceUsageRangeMode }
  | { type: 'set-start'; value: string }
  | { type: 'set-end'; value: string }
  | { type: 'apply' }
  | { type: 'reset' }

export const DEFAULT_FINANCE_USAGE_RANGE: FinanceUsageRange = {
  mode: 'day',
  start: '',
  end: '',
}

export const initialFinanceUsageRangeState: FinanceUsageRangeState = {
  draft: DEFAULT_FINANCE_USAGE_RANGE,
  applied: DEFAULT_FINANCE_USAGE_RANGE,
}

export function financeUsageRangeReducer(
  state: FinanceUsageRangeState,
  action: FinanceUsageRangeAction,
): FinanceUsageRangeState {
  switch (action.type) {
    case 'set-mode':
      return { ...state, draft: { mode: action.mode, start: '', end: '' } }
    case 'set-start':
      return { ...state, draft: { ...state.draft, start: action.value } }
    case 'set-end':
      return { ...state, draft: { ...state.draft, end: action.value } }
    case 'apply':
      return { ...state, applied: { ...state.draft } }
    case 'reset':
      return { draft: DEFAULT_FINANCE_USAGE_RANGE, applied: DEFAULT_FINANCE_USAGE_RANGE }
  }
}

export function financeUsageRangeHasPendingChanges(state: FinanceUsageRangeState): boolean {
  return state.draft.mode !== state.applied.mode
    || state.draft.start !== state.applied.start
    || state.draft.end !== state.applied.end
}
