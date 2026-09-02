// Hard PII patterns
export const pii = /(\b\d{3}-\d{2}-\d{4}\b|\b\d{10}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d+\s+\w+\s+(street|st|road|rd|avenue|ave|lane|ln)\b)/i;

// Soft PII patterns — phrases that suggest sharing personal info
const softPatterns = [
  { pattern: /\bmy name is\b/i, type: 'real name' },
  { pattern: /\bi live (at|in|on)\b/i, type: 'location' },
  { pattern: /\bmy address (is|:)\b/i, type: 'address' },
  { pattern: /\bi work (at|for)\b/i, type: 'workplace' },
  { pattern: /\bi go to\b/i, type: 'school/location' },
  { pattern: /\bmy (phone|number|cell|mobile) (number|is|:)\b/i, type: 'phone number' },
  { pattern: /\bmy email (is|:)\b/i, type: 'email' },
  { pattern: /\bi (attend|study at|learn at)\b/i, type: 'school' },
  { pattern: /\bmy (age|birthday|dob) is\b/i, type: 'personal info' },
  { pattern: /\bi am \d{1,2} years old\b/i, type: 'age' },
  { pattern: /\bmy (password|pin) is\b/i, type: 'credentials' },
  { pattern: /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/, type: 'phone number' },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, type: 'email address' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, type: 'SSN' },
];

/**
 * Returns null if clean, or { type, message } if PII detected.
 */
export function piiWarning(text) {
  if (!text) return null;
  if (pii.test(text)) return { type: 'personal information', message: 'This message may contain personal information (phone, email, SSN, or address).' };
  for (const { pattern, type } of softPatterns) {
    if (pattern.test(text)) return { type, message: `This message may contain ${type}. Are you sure you want to share this?` };
  }
  return null;
}
