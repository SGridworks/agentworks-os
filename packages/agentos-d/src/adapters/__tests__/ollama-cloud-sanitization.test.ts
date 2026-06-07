import { describe, it, expect } from 'vitest';
import { sanitize } from '../ollama-cloud-tool-adapter';

describe('Ollama Cloud sanitize function', () => {
  it('accepts empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('rejects null with precise error', () => {
    expect(() => sanitize(null)).toThrowError('Invalid content type: must be string');
  });

  it('rejects undefined with precise error', () => {
    expect(() => sanitize(undefined)).toThrowError('Invalid content type: must be string');
  });

  it('rejects arrays with precise error', () => {
    expect(() => sanitize(['array'])).toThrowError('Invalid content type: must be string');
  });

  it('rejects numbers with precise error', () => {
    expect(() => sanitize(123)).toThrowError('Invalid content type: must be string');
  });

  it('rejects objects with precise error', () => {
    expect(() => sanitize({})).toThrowError('Invalid content type: must be string');
  });
});