export function visibleModelsPageSections(canModelMarkup: boolean): string[] {
  return ["model-status", ...(canModelMarkup ? ["model-markup"] : [])];
}
