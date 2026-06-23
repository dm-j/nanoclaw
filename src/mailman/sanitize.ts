// ponytail: naive line-scan, proper MIME parser if this misclassifies

const MAX_EMAIL_BYTES = 32_000;

// Headers that carry authority — if not verified by the ingress, prefix with Unverified-
const AUTHORITY_HEADERS = new Set(['from', 'sender', 'reply-to', 'return-path', 'organization', 'x-originating-ip']);

// Headers stamped by mailman ingresses — these are trusted
const TRUSTED_PREFIXES = ['x-mailman-', 'x-verified-'];

function isAuthorityHeader(line: string): string | null {
  const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (AUTHORITY_HEADERS.has(name)) return match[1];
  return null;
}

function isTrustedHeader(line: string): boolean {
  const lower = line.toLowerCase();
  return TRUSTED_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Rewrite authority headers that weren't verified by the ingress.
 * Ingresses stamp verified values as X-Verified-From etc.
 * Raw From/Sender/Reply-To become Unverified-From etc.
 */
function sanitizeHeaders(lines: string[]): string[] {
  const out: string[] = [];
  let pastHeaders = false;

  for (const line of lines) {
    if (pastHeaders) {
      out.push(line);
      continue;
    }

    // Empty line = end of headers
    if (line.trim() === '') {
      pastHeaders = true;
      out.push(line);
      continue;
    }

    // Don't touch our own trusted headers
    if (isTrustedHeader(line)) {
      out.push(line);
      continue;
    }

    const authorityName = isAuthorityHeader(line);
    if (authorityName) {
      out.push(line.replace(authorityName + ':', `Unverified-${authorityName}:`));
      continue;
    }

    out.push(line);
  }

  return out;
}

export function sanitizeEmail(raw: string): string {
  const lines = raw.split('\n');
  const sanitized = sanitizeHeaders(lines);

  if (raw.length <= MAX_EMAIL_BYTES) return sanitized.join('\n');

  const out: string[] = [];
  let inBase64 = false;
  let strippedType = '';
  let strippedBytes = 0;

  for (const line of sanitized) {
    if (/^Content-Transfer-Encoding:\s*base64/i.test(line)) {
      inBase64 = true;
      out.push(line);
      continue;
    }

    if (inBase64) {
      if (/^--/.test(line)) {
        if (strippedBytes > 0) {
          out.push(`[attachment stripped: ${strippedType || 'unknown'}, ${(strippedBytes / 1024).toFixed(0)}KB]`);
          strippedBytes = 0;
          strippedType = '';
        }
        inBase64 = false;
        out.push(line);
        continue;
      }
      if (/^Content-Type:\s*(.+)/i.test(line)) {
        strippedType = RegExp.$1.split(';')[0].trim();
        out.push(line);
        continue;
      }
      strippedBytes += line.length;
      continue;
    }

    out.push(line);
  }

  if (strippedBytes > 0) {
    out.push(`[attachment stripped: ${strippedType || 'unknown'}, ${(strippedBytes / 1024).toFixed(0)}KB]`);
  }

  const result = out.join('\n');
  if (result.length > MAX_EMAIL_BYTES) {
    return result.slice(0, MAX_EMAIL_BYTES) + '\n[truncated]';
  }
  return result;
}
