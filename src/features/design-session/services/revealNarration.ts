/**
 * The bot's spoken line for the reveal moment.
 *
 * ADR-0012 requires axis selection to be LOGGED, never silent — but the log
 * is an audit artifact, not chat copy. A live session rendered the raw
 * `axisSelection.rationale` ("Questionnaire mode: intake left bold-fine and
 * minimal-ornate unresolved; the reveal varies both so the user's pick
 * answers them without being asked.") as a bot message, which is internal
 * machinery leaking to the user. The rationale stays on the session record
 * for auditing; THIS is what the user hears.
 *
 * Spec 10 adds the "because you said" clause: the line says what it heard
 * before it says how it split the cuts. The clause is built only from safe
 * fields — the placement, and characters VERIFIED against the catalog
 * (`characterIdentities`). It never quotes `meaning` (freeform, often
 * personal: memorials, names) or the freeform `subject` prose; a request
 * with no verified character gets the placement alone.
 */
import type { AxisSelection, IntakeRecord, VariationAxis } from '@/services/intake/types';

/** How each axis is spoken about, consultant-voice — never the internal id. */
export const AXIS_SPOKEN: Record<VariationAxis, string> = {
  'bold-fine': 'line weight',
  'color-blackwork': 'color versus black ink',
  'literal-abstract': 'literal versus abstract',
  'minimal-ornate': 'how much detail they carry',
};

const MAX_CLAUSE_PART = 40;

/** Trim to `max` characters at a word boundary, with an ellipsis when cut. */
export function trimAtWord(text: string, max: number = MAX_CLAUSE_PART): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : clean.slice(0, max)).replace(/[,;:\s]+$/, '')}…`;
}

/** The verified cast, spoken: "Deku", "Deku and Bakugo", "your cast of four". */
export function spokenCast(intake: Pick<IntakeRecord, 'characterIdentities'>): string | undefined {
  const names = (intake.characterIdentities ?? []).map((identity) => identity.name.trim()).filter(Boolean);
  if (names.length === 0) return undefined;
  if (names.length === 1) return trimAtWord(names[0]);
  if (names.length === 2) return trimAtWord(`${names[0]} and ${names[1]}`);
  return `your cast of ${names.length}`;
}

/** "You asked for Deku on your forearm" / "For your forearm" / nothing. */
function becauseClause(
  intake?: Pick<IntakeRecord, 'placement' | 'characterIdentities'>
): { lead: string; joiner: string } | undefined {
  if (!intake) return undefined;
  const placement = intake.placement?.trim() ? trimAtWord(intake.placement.toLowerCase()) : undefined;
  const cast = spokenCast(intake);
  if (cast && placement) return { lead: `You asked for ${cast} on your ${placement}`, joiner: ', so ' };
  if (cast) return { lead: `You asked for ${cast}`, joiner: ', so ' };
  if (placement) return { lead: `For your ${placement}`, joiner: ', ' };
  return undefined;
}

export function revealNarration(
  axisSelection: AxisSelection,
  intake?: Pick<IntakeRecord, 'placement' | 'characterIdentities'>
): string {
  if (axisSelection.mode === 'compositional' || axisSelection.axes.length === 0) {
    return 'Style is locked in, so these two play with pose, framing, and negative space.';
  }
  const spoken = axisSelection.axes.map(
    (axis) => AXIS_SPOKEN[axis] ?? axis.replace(/-/g, ' vs ')
  );
  const split = spoken.length > 1 ? `${spoken[0]} and ${spoken[1]}` : spoken[0];
  const because = becauseClause(intake);
  const body = `${split} — your pick tells me which way to lean.`;
  return because
    ? `${because.lead}${because.joiner}I split these two on ${body}`
    : `I split these two on ${body}`;
}
