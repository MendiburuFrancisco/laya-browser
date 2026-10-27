const SECRET = /(?:authorization\s*[:=]\s*bearer\s+|(?:api[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/ig;

export function redactLog(text) {
  return String(text).replace(SECRET, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`);
}
