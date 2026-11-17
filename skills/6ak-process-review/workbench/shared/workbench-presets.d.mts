type WorkbenchPreset = Readonly<{
  id: string;
  label: string;
  instruction: string;
}>;

export const PRESETS: readonly WorkbenchPreset[];
export const STRUCTURE_PRESETS: readonly WorkbenchPreset[];
export const normalizationInstruction: string;

export type HandoffTarget = Readonly<{ type: string; id: string; label: string }>;
export type HandoffQuote = Readonly<{ text: string; claimId: string; sourceLabel?: string }>;

type HandoffSelection = {
  presetId: string;
  processingTargets?: readonly HandoffTarget[];
  referenceTargets?: readonly HandoffTarget[];
};

export function buildPresetTask(options: HandoffSelection): string;

export function formatPresetHandoff(options: HandoffSelection & {
  reference: string;
  draft?: string;
  task?: string;
  quote?: HandoffQuote;
}): string;
