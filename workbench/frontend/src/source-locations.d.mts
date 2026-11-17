export function sourceLocationsFor(
  claims: Array<{ origin: string; evidence: Array<{ sourceId: string; startLine: number; endLine: number }> }>,
  sources: Array<{ id: string; name: string; text: string; kind?: string }>,
): Array<{ key: string; label: string; origin: string }>;
