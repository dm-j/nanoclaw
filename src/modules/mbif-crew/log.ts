/**
 * Audit log for prompt_mbif_crew — every request, approved or denied, one
 * running file (not per-hour like the briefing log; this is low-volume and
 * an audit trail benefits from staying in one place). Deliberately outside
 * the vault, same reasoning as BRIEFING_LOG_DIR.
 */
import fs from 'fs';

import { MBIF_CREW_LOG_PATH, TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import { formatLocalStamp } from '../../timezone.js';

export function appendMbifCrewLog(entry: {
  agentGroupId: string;
  instruction: string;
  outcome: 'approved' | 'denied';
  preCommit?: string;
  postCommit?: string;
  error?: string;
}): void {
  try {
    fs.mkdirSync(MBIF_CREW_LOG_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
    const stamp = formatLocalStamp(new Date(), TIMEZONE);
    const lines = [
      `## ${stamp} — ${entry.outcome}`,
      '',
      `**Agent group:** ${entry.agentGroupId}`,
      `**Instruction:** ${entry.instruction}`,
    ];
    if (entry.preCommit) lines.push(`**Pre-execution commit:** ${entry.preCommit}`);
    if (entry.postCommit) lines.push(`**Post-execution commit:** ${entry.postCommit}`);
    if (entry.error) lines.push(`**Error:** ${entry.error}`);
    lines.push('', '---', '');
    fs.appendFileSync(MBIF_CREW_LOG_PATH, lines.join('\n'));
  } catch (err) {
    log.warn('mbif-crew log write failed (non-fatal)', { err });
  }
}
