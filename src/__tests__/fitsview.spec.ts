/**
 * Unit tests for fitsview extension
 */

import { createTypedArray } from '../handler';

describe('createTypedArray', () => {
  it('should create Float32Array for <f4 dtype', () => {
    const buffer = new ArrayBuffer(16);
    const result = createTypedArray(buffer, '<f4');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(4);
  });

  it('should create Float64Array for <f8 dtype', () => {
    const buffer = new ArrayBuffer(16);
    const result = createTypedArray(buffer, '<f8');
    expect(result).toBeInstanceOf(Float64Array);
    expect(result.length).toBe(2);
  });

  it('should create Int16Array for <i2 dtype', () => {
    const buffer = new ArrayBuffer(16);
    const result = createTypedArray(buffer, '<i2');
    expect(result).toBeInstanceOf(Int16Array);
    expect(result.length).toBe(8);
  });

  it('should create Int32Array for <i4 dtype', () => {
    const buffer = new ArrayBuffer(16);
    const result = createTypedArray(buffer, '<i4');
    expect(result).toBeInstanceOf(Int32Array);
    expect(result.length).toBe(4);
  });

  it('should create Uint8Array for <u1 dtype', () => {
    const buffer = new ArrayBuffer(16);
    const result = createTypedArray(buffer, '<u1');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(16);
  });

  it('should strip byte order prefix and still work', () => {
    const buffer = new ArrayBuffer(16);
    // Test that >f4 (big-endian marker) still creates Float32Array
    // (server converts to little-endian before sending)
    const result = createTypedArray(buffer, '>f4');
    expect(result).toBeInstanceOf(Float32Array);
  });

  it('should default to Float64Array for unknown dtype', () => {
    const buffer = new ArrayBuffer(16);
    const result = createTypedArray(buffer, 'unknown');
    expect(result).toBeInstanceOf(Float64Array);
  });
});
