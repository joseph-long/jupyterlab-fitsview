import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * Call the FITS API extension
 *
 * @param endPoint API REST end point for the extension
 * @param init Initial values for the request
 * @returns The response body interpreted as JSON
 */
export async function requestAPI<T>(
  endPoint = '',
  init: RequestInit = {}
): Promise<T> {
  const settings = ServerConnection.makeSettings();
  const requestUrl = URLExt.join(
    settings.baseUrl,
    'fitsview', // API Namespace
    endPoint
  );

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(requestUrl, init, settings);
  } catch (error) {
    throw new ServerConnection.NetworkError(error as any);
  }

  let data: any = await response.text();

  if (data.length > 0) {
    try {
      data = JSON.parse(data);
    } catch (error) {
      console.log('Not a JSON response body.', response);
    }
  }

  if (!response.ok) {
    throw new ServerConnection.ResponseError(response, data.message || data);
  }

  return data;
}

/**
 * Call the FITS API extension and return binary data
 *
 * @param endPoint API REST end point for the extension
 * @param init Initial values for the request
 * @returns The response body as ArrayBuffer and shape from header
 */
export async function requestBinaryAPI(
  endPoint = '',
  init: RequestInit = {}
): Promise<{ buffer: ArrayBuffer; shape: number[]; dtype: string }> {
  const settings = ServerConnection.makeSettings();
  const requestUrl = URLExt.join(
    settings.baseUrl,
    'fitsview', // API Namespace
    endPoint
  );

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(requestUrl, init, settings);
  } catch (error) {
    throw new ServerConnection.NetworkError(error as any);
  }

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const json = JSON.parse(text);
      message = json.error || json.message || text;
    } catch {
      // Not JSON, use text as-is
    }
    throw new ServerConnection.ResponseError(response, message);
  }

  const buffer = await response.arrayBuffer();
  const shapeHeader = response.headers.get('X-FITS-Shape');
  const shape = shapeHeader ? JSON.parse(shapeHeader) : [];
  const dtype = response.headers.get('X-FITS-Dtype') || '<f8';

  return { buffer, shape, dtype };
}

/**
 * Create a TypedArray from an ArrayBuffer based on numpy dtype string.
 * Assumes little-endian byte order (server converts to LE before sending).
 */
export function createTypedArray(
  buffer: ArrayBuffer,
  dtype: string
): Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | BigInt64Array | BigUint64Array {
  // Strip byte order prefix if present (we know it's little-endian)
  const cleanDtype = dtype.replace(/^[<>|]/, '');

  switch (cleanDtype) {
    case 'i1':
    case 'b':
      return new Int8Array(buffer);
    case 'u1':
    case 'B':
      return new Uint8Array(buffer);
    case 'i2':
      return new Int16Array(buffer);
    case 'u2':
      return new Uint16Array(buffer);
    case 'i4':
      return new Int32Array(buffer);
    case 'u4':
      return new Uint32Array(buffer);
    case 'i8':
      return new BigInt64Array(buffer);
    case 'u8':
      return new BigUint64Array(buffer);
    case 'f4':
      return new Float32Array(buffer);
    case 'f8':
    default:
      return new Float64Array(buffer);
  }
}
