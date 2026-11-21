type Group = { id: string; title: string; kind?: string; claimIds?: string[] };
type Model<G> = {
  groups: G[];
  claims: { id: string; text: string; origin: string; evidence: { sourceId: string; startLine: number; endLine: number; quote: string }[] }[];
  sources: { id: string; name: string; text?: string }[];
};
export function groupsForDisplay<G extends Group>(model?: Model<G>): Array<G & { sourceStage?: string; stageLocation?: string }>;
