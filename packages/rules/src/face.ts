/**
 * Automatic face matching (D-36 stage 2). Two photos are turned into face descriptors and
 * compared; the smaller the distance, the more alike. A result is only ever a flag for a person
 * to look at: it never blocks a guard or starts anything by itself.
 */

/** Below this the two photos are very likely the same person. */
export const FACE_MATCH_BELOW = 0.5;
/** At or above this they are very likely different people. In between: uncertain. */
export const FACE_NO_MATCH_FROM = 0.6;

export type FaceVerdict = 'match' | 'uncertain' | 'no_match' | 'no_face';

export function faceVerdict(distance: number | null | undefined): FaceVerdict {
  if (distance == null || !Number.isFinite(distance)) return 'no_face';
  if (distance < FACE_MATCH_BELOW) return 'match';
  if (distance < FACE_NO_MATCH_FROM) return 'uncertain';
  return 'no_match';
}

/** An easy number to show people: 100% identical, 0% nothing alike. */
export function faceSimilarity(distance: number | null | undefined): number | null {
  if (distance == null || !Number.isFinite(distance)) return null;
  return Math.max(0, Math.min(100, Math.round((1 - distance) * 100)));
}

export const FACE_VERDICT_LABEL: Record<FaceVerdict, string> = {
  match: 'Likely the same person',
  uncertain: 'Uncertain: please look',
  no_match: 'Possibly a different person',
  no_face: 'No clear face found',
};

export const FACE_CHECK_KINDS = ['enrolment_id_document', 'enrolment_psira_card', 'duty_selfie'] as const;
export type FaceCheckKind = (typeof FACE_CHECK_KINDS)[number];

export const FACE_CHECK_LABEL: Record<FaceCheckKind, string> = {
  enrolment_id_document: 'Face photo against the ID document',
  enrolment_psira_card: 'Face photo against the PSIRA card',
  duty_selfie: 'Selfie against the enrolment photo',
};
