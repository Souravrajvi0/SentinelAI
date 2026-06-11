import type { Message, GuardrailAction } from '@sentinelai/shared';

export interface GuardrailResult {
  passed: boolean;
  action?: GuardrailAction;
  reasons: string[];
  sanitized_messages?: Message[];
}

// ── Prompt injection patterns ──────────────────────────────────────────────
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(a\s+)?(?:jailbroken|DAN|evil)/i,
  /disregard\s+(your\s+)?(system\s+prompt|instructions)/i,
  /pretend\s+(you\s+(have\s+no|are)\s+|there\s+(are\s+no|is\s+no))/i,
  /\[system\]/i,
  /<\|im_start\|>system/i,
];

// ── PII patterns (redact before sending to LLM) ───────────────────────────
const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    // Credit card numbers
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    replacement: '[REDACTED_CC]',
  },
  {
    // US SSN
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: '[REDACTED_SSN]',
  },
  {
    // Email addresses
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED_EMAIL]',
  },
  {
    // Phone numbers (US-ish)
    pattern: /\b(\+1[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g,
    replacement: '[REDACTED_PHONE]',
  },
];

// ── Policy violations ──────────────────────────────────────────────────────
const POLICY_PATTERNS = [
  { pattern: /\b(make|build|create|synthesize)\s+.{0,30}(bomb|weapon|explosive)/i, reason: 'dangerous_content' },
  { pattern: /\b(hack|exploit|attack)\s+.{0,20}(server|database|system)/i, reason: 'cyberattack_intent' },
];

export function checkGuardrails(messages: Message[]): GuardrailResult {
  const reasons: string[] = [];

  // Check all user messages for injection
  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(msg.content)) {
        reasons.push('prompt_injection');
        break;
      }
    }

    for (const { pattern, reason } of POLICY_PATTERNS) {
      if (pattern.test(msg.content)) {
        reasons.push(reason);
      }
    }
  }

  if (reasons.length > 0) {
    return { passed: false, action: 'blocked', reasons };
  }

  // PII redaction — always run, return sanitized messages
  const sanitized_messages = messages.map((msg) => {
    if (msg.role !== 'user') return msg;
    let content = msg.content;
    let redacted = false;
    for (const { pattern, replacement } of PII_PATTERNS) {
      const newContent = content.replace(pattern, replacement);
      if (newContent !== content) {
        content = newContent;
        redacted = true;
      }
    }
    if (redacted) reasons.push('pii_redacted');
    return { ...msg, content };
  });

  return {
    passed: true,
    action: reasons.length > 0 ? 'redacted' : undefined,
    reasons,
    sanitized_messages,
  };
}
