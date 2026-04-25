import { describe, expect, it } from 'vitest';
import { normalizePhoneE164, phoneToWhatsAppJid } from '../subject-identities';

describe('normalizePhoneE164', () => {
  it('keeps a clean E.164 number', () => {
    expect(normalizePhoneE164('+447123456789')).toBe('+447123456789');
  });

  it('strips spaces, dashes, parens, and dots', () => {
    expect(normalizePhoneE164('+44 (0) 7123-456.789')).toBe('+447123456789');
    expect(normalizePhoneE164(' + 44 7123 456 789 ')).toBe('+447123456789');
  });

  it('treats leading 00 as international prefix', () => {
    expect(normalizePhoneE164('00447123456789')).toBe('+447123456789');
  });

  it('assumes UK +44 for a national-format number starting with 0', () => {
    expect(normalizePhoneE164('07123456789')).toBe('+447123456789');
  });

  it('rejects strings that do not produce 7-15 digits', () => {
    expect(normalizePhoneE164('abc')).toBeNull();
    expect(normalizePhoneE164('+12')).toBeNull();
    expect(normalizePhoneE164('+1234567890123456')).toBeNull();
  });

  it('handles non-UK E.164 too', () => {
    expect(normalizePhoneE164('+15551234567')).toBe('+15551234567');
    expect(normalizePhoneE164('+33612345678')).toBe('+33612345678');
  });
});

describe('phoneToWhatsAppJid', () => {
  it('drops the leading + and appends the WhatsApp suffix', () => {
    expect(phoneToWhatsAppJid('+447123456789')).toBe('447123456789@s.whatsapp.net');
    expect(phoneToWhatsAppJid('+15551234567')).toBe('15551234567@s.whatsapp.net');
  });
});
