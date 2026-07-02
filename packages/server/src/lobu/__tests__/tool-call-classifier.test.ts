import { describe, expect, it } from 'bun:test';
import { classifyToolCallFailure } from '../tool-call-classifier';

describe('classifyToolCallFailure', () => {
  it.each([
    ['401 unauthorized from upstream', { httpStatus: 401 }, 'needs_reauth'],
    ['403 insufficient scope', { httpStatus: 403 }, 'needs_reauth'],
    ['oauth keyword in message', { errorMessage: 'OAuth token expired' }, 'needs_reauth'],
    ['timeout', { errorMessage: 'fetch timed out' }, 'transient_error'],
    ['5xx upstream', { httpStatus: 502 }, 'transient_error'],
    ['network error', { errorMessage: 'ECONNRESET' }, 'transient_error'],
  ] as const)('%s → %s', (_name, input, expected) => {
    expect(classifyToolCallFailure(input)).toBe(expected);
  });

  it('default-deny：無法辨識的錯誤一律 transient_error，絕不 not_connected', () => {
    expect(classifyToolCallFailure({ errorMessage: 'something inexplicable' })).toBe('transient_error');
    expect(classifyToolCallFailure({})).toBe('transient_error');
  });

  it('tool allowlist / missing tool 屬 config_error', () => {
    expect(classifyToolCallFailure({ errorMessage: 'tool not found in tools/list' })).toBe('config_error');
  });

  it('regression: config 訊息含 auth 子字串不得被誤判成 needs_reauth', () => {
    expect(classifyToolCallFailure({ errorMessage: 'unknown tool: author-lookup' })).toBe('config_error');
  });

  it('regression: "password reset" 不是網路 reset，走 default-deny → transient_error', () => {
    expect(classifyToolCallFailure({ errorMessage: 'user requested password reset' })).toBe('transient_error');
  });

  it('regression: "authority" 不得因 auth 裸子字串被判 needs_reauth', () => {
    expect(classifyToolCallFailure({ errorMessage: 'invalid authority certificate' })).not.toBe('needs_reauth');
  });

  it.each([
    ['authentication failed', { errorMessage: 'authentication failed' }, 'needs_reauth'],
    ['invalid credentials', { errorMessage: 'invalid credentials' }, 'needs_reauth'],
    ['expired tokens', { errorMessage: 'expired tokens' }, 'needs_reauth'],
    ['authorization failed', { errorMessage: 'authorization failed' }, 'needs_reauth'],
  ] as const)('regression (recall): %s → %s', (_name, input, expected) => {
    expect(classifyToolCallFailure(input)).toBe(expected);
  });
});
