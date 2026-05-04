import { describe, expect, test } from 'bun:test';
import { calculateEngagementScore } from '../scoring.js';

describe('calculateEngagementScore - reddit', () => {
  test('returns score / 100 for typical positive score', () => {
    expect(calculateEngagementScore('reddit', { score: 500 })).toBe(5);
  });

  test('caps reddit score at 100 (10000 input)', () => {
    expect(calculateEngagementScore('reddit', { score: 25000 })).toBe(100);
  });

  test('clamps negative reddit score to 0', () => {
    expect(calculateEngagementScore('reddit', { score: -123 })).toBe(0);
  });

  test('returns 0 when score is missing', () => {
    expect(calculateEngagementScore('reddit', {})).toBe(0);
  });

  test('reddit at exactly 10000 yields 100', () => {
    expect(calculateEngagementScore('reddit', { score: 10000 })).toBe(100);
  });
});

describe('calculateEngagementScore - generic rating-based', () => {
  test('rating multiplied by 10 plus helpful * 0.5', () => {
    expect(calculateEngagementScore('google_play', { rating: 4, helpful_count: 10 })).toBe(45);
  });

  test('caps rating-based score at 100', () => {
    expect(calculateEngagementScore('google_play', { rating: 5, helpful_count: 1000 })).toBe(100);
  });

  test('rating with no helpful_count', () => {
    expect(calculateEngagementScore('google_play', { rating: 3 })).toBe(30);
  });

  test('rating of 0 is treated explicitly when present', () => {
    // rating != null is the branch trigger.
    expect(calculateEngagementScore('app_store', { rating: 0, helpful_count: 4 })).toBe(2);
  });
});

describe('calculateEngagementScore - generic score-based', () => {
  test('falls back to score directly when no rating', () => {
    expect(calculateEngagementScore('hackernews', { score: 42 })).toBe(42);
  });

  test('caps generic score at 100', () => {
    expect(calculateEngagementScore('hackernews', { score: 999 })).toBe(100);
  });

  test('returns 0 when score missing in default branch', () => {
    expect(calculateEngagementScore('hackernews', {})).toBe(0);
  });
});
