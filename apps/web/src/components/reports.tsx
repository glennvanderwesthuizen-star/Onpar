'use client';

import { PRIORITY_LABELS, Priority, Stage, STAGES, STAGE_LABELS } from '@onpar/rules';
import { Pill } from './ui';

/** The report number in the report's own colour (section 24). */
export function ReportBadge({ number, colour }: { number: number; colour: string }) {
  return (
    <span className="rbadge" style={{ background: colour }} aria-label={`Report ${number}`}>
      #{number}
    </span>
  );
}

/** Three flat dots; only the real priority is lit (section 24). */
export function TrafficLight({ priority }: { priority: Priority }) {
  return (
    <span className="tlight" role="img" aria-label={`${PRIORITY_LABELS[priority]} priority`} title={`${PRIORITY_LABELS[priority]} priority`}>
      <i className={priority === 'green' ? 'g' : ''} />
      <i className={priority === 'amber' ? 'a' : ''} />
      <i className={priority === 'red' ? 'r' : ''} />
    </span>
  );
}

export function StagePill({ stage }: { stage: Stage }) {
  const tone = stage === 'closed' ? 'green' : stage === 'reported' ? 'amber' : 'blue';
  return <Pill tone={tone}>{STAGE_LABELS[stage]}</Pill>;
}

/** Where the report is in the six stages. */
export function StageProgress({ stage }: { stage: Stage }) {
  const at = STAGES.indexOf(stage);
  return (
    <div className="stages" aria-label={`Stage: ${STAGE_LABELS[stage]}`}>
      {STAGES.map((s, i) => (
        <span key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>
          {STAGE_LABELS[s]}
        </span>
      ))}
    </div>
  );
}
