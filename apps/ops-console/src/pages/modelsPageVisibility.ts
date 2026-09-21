export function visibleModelsPageSections(canModelMarkup: boolean): string[] {
  return canModelMarkup ? ["model-markup"] : [];
}
