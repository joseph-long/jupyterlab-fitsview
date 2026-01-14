import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * Enum mapping TypedArray type names to constructors.
 * Values match the Python ArrayType enum in handlers.py.
 */
export enum ArrayType {
  INT8 = 'Int8Array',
  UINT8 = 'Uint8Array',
  INT16 = 'Int16Array',
  UINT16 = 'Uint16Array',
  INT32 = 'Int32Array',
  UINT32 = 'Uint32Array',
  BIGINT64 = 'BigInt64Array',
  BIGUINT64 = 'BigUint64Array',
  FLOAT32 = 'Float32Array',
  FLOAT64 = 'Float64Array'
}

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
    // Extract error message from various response formats
    let errorMessage = 'Unknown error';
    if (typeof data === 'string') {
      errorMessage = data;
    } else if (data && typeof data === 'object') {
      errorMessage = data.error || data.message || JSON.stringify(data);
    }
    throw new ServerConnection.ResponseError(response, errorMessage);
  }

  return data;
}

/**
 * Call the FITS API extension and return binary data
 *
 * @param endPoint API REST end point for the extension
 * @param init Initial values for the request
 * @returns The response body as ArrayBuffer, shape, and arrayType from headers
 */
export async function requestBinaryAPI(
  endPoint = '',
  init: RequestInit = {}
): Promise<{ buffer: ArrayBuffer; shape: number[]; arrayType: ArrayType }> {
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
  const typeHeader = response.headers.get('X-FITS-Type');
  const arrayType = (typeHeader as ArrayType) || ArrayType.FLOAT64;

  return { buffer, shape, arrayType };
}

/**
 * TypedArray type union for all supported array types
 */
export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

/**
 * Create a TypedArray from an ArrayBuffer based on ArrayType enum.
 * Assumes little-endian byte order (server converts to LE before sending).
 */
export function createTypedArray(
  buffer: ArrayBuffer,
  arrayType: ArrayType
): TypedArray {
  switch (arrayType) {
    case ArrayType.INT8:
      return new Int8Array(buffer);
    case ArrayType.UINT8:
      return new Uint8Array(buffer);
    case ArrayType.INT16:
      return new Int16Array(buffer);
    case ArrayType.UINT16:
      return new Uint16Array(buffer);
    case ArrayType.INT32:
      return new Int32Array(buffer);
    case ArrayType.UINT32:
      return new Uint32Array(buffer);
    case ArrayType.BIGINT64:
      return new BigInt64Array(buffer);
    case ArrayType.BIGUINT64:
      return new BigUint64Array(buffer);
    case ArrayType.FLOAT32:
      return new Float32Array(buffer);
    case ArrayType.FLOAT64:
    default:
      return new Float64Array(buffer);
  }
}
