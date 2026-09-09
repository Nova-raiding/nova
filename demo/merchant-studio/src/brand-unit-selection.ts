export function brandUnitSelectionMessage(candidateCount: number): string {
  const count = Number.isFinite(candidateCount) && candidateCount > 0 ? Math.floor(candidateCount) : 0
  return `品牌档案尚未关联批量生产品牌单元；当前工作区有 ${count} 个候选。brand-unit.list 仅用于查看候选，关联操作需由有权限的运营工作台或插件完成。`
}
