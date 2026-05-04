import { describe, expect, test } from 'bun:test';
import {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeGithubLogin,
  normalizeGoogleContactId,
  normalizeIdentifier,
  normalizePhone,
  normalizeSlackUserId,
  normalizeWaJid,
} from '../identity-normalize.js';

describe('normalizePhone', () => {
  test('strips spaces, dashes, parens, and leading +', () => {
    expect(normalizePhone('+1 (415) 555-1234')).toBe('14155551234');
  });

  test('returns digit-only string when input is already clean', () => {
    expect(normalizePhone('14155551234')).toBe('14155551234');
  });

  test('returns null for input below the digit floor', () => {
    expect(normalizePhone('123456')).toBeNull();
  });

  test('returns null for input above the digit ceiling', () => {
    expect(normalizePhone('1234567890123456')).toBeNull();
  });

  test('returns null for null and undefined inputs', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  test('returns null for non-string inputs', () => {
    // @ts-expect-error
    expect(normalizePhone(12345 as unknown as string)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(normalizePhone('')).toBeNull();
  });

  test('returns null for string of letters only', () => {
    expect(normalizePhone('abc-def-ghij')).toBeNull();
  });
});

describe('normalizeEmail', () => {
  test('lowercases and trims valid email', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
  });

  test('returns null for missing @', () => {
    expect(normalizeEmail('foo.example.com')).toBeNull();
  });

  test('returns null for multiple @', () => {
    expect(normalizeEmail('foo@bar@example.com')).toBeNull();
  });

  test('returns null for empty local part', () => {
    expect(normalizeEmail('@example.com')).toBeNull();
  });

  test('returns null for trailing @', () => {
    expect(normalizeEmail('foo@')).toBeNull();
  });

  test('returns null when domain has no dot', () => {
    expect(normalizeEmail('foo@bar')).toBeNull();
  });

  test('returns null for whitespace inside email', () => {
    expect(normalizeEmail('foo bar@example.com')).toBeNull();
  });

  test('returns null for null/undefined/empty', () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
  });

  test('preserves unicode local part lowercased', () => {
    // Email should still be processed if it has unicode chars without spaces.
    expect(normalizeEmail('Üser@Example.COM')).toBe('üser@example.com');
  });
});

describe('normalizeWaJid', () => {
  test('strips device suffix', () => {
    expect(normalizeWaJid('14155551234:5@s.whatsapp.net')).toBe('14155551234@s.whatsapp.net');
  });

  test('lowercases input', () => {
    expect(normalizeWaJid('14155551234@S.WHATSAPP.NET')).toBe('14155551234@s.whatsapp.net');
  });

  test('preserves @lid suffix', () => {
    expect(normalizeWaJid('abc123@lid')).toBe('abc123@lid');
  });

  test('preserves @g.us group suffix', () => {
    expect(normalizeWaJid('123-456@g.us')).toBe('123-456@g.us');
  });

  test('preserves @broadcast suffix', () => {
    expect(normalizeWaJid('1234@broadcast')).toBe('1234@broadcast');
  });

  test('preserves @newsletter suffix', () => {
    expect(normalizeWaJid('abc.def@newsletter')).toBe('abc.def@newsletter');
  });

  test('returns null for unknown suffix', () => {
    expect(normalizeWaJid('1234@example.com')).toBeNull();
  });

  test('returns null for malformed JID', () => {
    expect(normalizeWaJid('not-a-jid')).toBeNull();
  });

  test('returns null for null/undefined/empty', () => {
    expect(normalizeWaJid(null)).toBeNull();
    expect(normalizeWaJid(undefined)).toBeNull();
    expect(normalizeWaJid('')).toBeNull();
    expect(normalizeWaJid('   ')).toBeNull();
  });
});

describe('normalizeSlackUserId', () => {
  test('combines team and user ids and uppercases', () => {
    expect(normalizeSlackUserId('t0xyz', 'u12345')).toBe('T0XYZ:U12345');
  });

  test('trims surrounding whitespace', () => {
    expect(normalizeSlackUserId('  T0XYZ  ', '  U12345  ')).toBe('T0XYZ:U12345');
  });

  test('returns null when team id is missing', () => {
    expect(normalizeSlackUserId('', 'U12345')).toBeNull();
    expect(normalizeSlackUserId(null, 'U12345')).toBeNull();
    expect(normalizeSlackUserId(undefined, 'U12345')).toBeNull();
  });

  test('returns null when user id is missing', () => {
    expect(normalizeSlackUserId('T0XYZ', '')).toBeNull();
    expect(normalizeSlackUserId('T0XYZ', null)).toBeNull();
    expect(normalizeSlackUserId('T0XYZ', undefined)).toBeNull();
  });

  test('returns null when team id has invalid chars', () => {
    expect(normalizeSlackUserId('T0!@#', 'U12345')).toBeNull();
  });

  test('returns null when user id has invalid chars', () => {
    expect(normalizeSlackUserId('T0XYZ', 'U12!@#')).toBeNull();
  });
});

describe('normalizeGithubLogin', () => {
  test('lowercases and trims', () => {
    expect(normalizeGithubLogin('  Octocat  ')).toBe('octocat');
  });

  test('preserves single hyphens', () => {
    expect(normalizeGithubLogin('foo-bar')).toBe('foo-bar');
  });

  test('returns null for empty', () => {
    expect(normalizeGithubLogin('')).toBeNull();
    expect(normalizeGithubLogin(null)).toBeNull();
    expect(normalizeGithubLogin(undefined)).toBeNull();
  });

  test('returns null for leading hyphen', () => {
    expect(normalizeGithubLogin('-foo')).toBeNull();
  });

  test('returns null for trailing hyphen', () => {
    expect(normalizeGithubLogin('foo-')).toBeNull();
  });

  test('returns null for double-hyphen', () => {
    expect(normalizeGithubLogin('foo--bar')).toBeNull();
  });

  test('returns null for too long', () => {
    expect(normalizeGithubLogin('a'.repeat(40))).toBeNull();
  });

  test('returns null for invalid characters', () => {
    expect(normalizeGithubLogin('foo!bar')).toBeNull();
    expect(normalizeGithubLogin('foo bar')).toBeNull();
  });
});

describe('normalizeGoogleContactId', () => {
  test('trims whitespace', () => {
    expect(normalizeGoogleContactId('  abc123  ')).toBe('abc123');
  });

  test('returns null for empty/whitespace', () => {
    expect(normalizeGoogleContactId('')).toBeNull();
    expect(normalizeGoogleContactId('   ')).toBeNull();
    expect(normalizeGoogleContactId(null)).toBeNull();
    expect(normalizeGoogleContactId(undefined)).toBeNull();
  });
});

describe('normalizeAuthUserId', () => {
  test('trims whitespace', () => {
    expect(normalizeAuthUserId('  user_123  ')).toBe('user_123');
  });

  test('returns null for empty/null/undefined', () => {
    expect(normalizeAuthUserId('')).toBeNull();
    expect(normalizeAuthUserId('   ')).toBeNull();
    expect(normalizeAuthUserId(null)).toBeNull();
    expect(normalizeAuthUserId(undefined)).toBeNull();
  });
});

describe('normalizeIdentifier', () => {
  test('dispatches phone namespace', () => {
    expect(normalizeIdentifier('phone', '+1 (415) 555-1234')).toBe('14155551234');
  });

  test('dispatches email namespace', () => {
    expect(normalizeIdentifier('email', '  Foo@Example.COM ')).toBe('foo@example.com');
  });

  test('dispatches wa_jid namespace', () => {
    expect(normalizeIdentifier('wa_jid', '14155551234:5@s.whatsapp.net')).toBe(
      '14155551234@s.whatsapp.net'
    );
  });

  test('dispatches github_login namespace', () => {
    expect(normalizeIdentifier('github_login', 'Octocat')).toBe('octocat');
  });

  test('dispatches google_contact_id namespace', () => {
    expect(normalizeIdentifier('google_contact_id', '  abc123  ')).toBe('abc123');
  });

  test('dispatches auth_user_id namespace', () => {
    expect(normalizeIdentifier('auth_user_id', '  user_123  ')).toBe('user_123');
  });

  test('unknown namespace falls back to trim', () => {
    expect(normalizeIdentifier('custom_namespace', '  hello  ')).toBe('hello');
  });

  test('unknown namespace returns null for empty', () => {
    expect(normalizeIdentifier('custom_namespace', '   ')).toBeNull();
    expect(normalizeIdentifier('custom_namespace', null)).toBeNull();
    expect(normalizeIdentifier('custom_namespace', undefined)).toBeNull();
  });
});
