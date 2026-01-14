"""
API handlers for FITS file operations.
"""

import json
import tornado
from jupyter_server.base.handlers import APIHandler, JupyterHandler
from jupyter_server.utils import url_path_join
from astropy.io import fits
import numpy as np


class FITSMetadataHandler(APIHandler):
    """Handler for retrieving FITS file metadata (headers, dimensions)."""

    @tornado.web.authenticated
    async def get(self):
        path = self.get_argument('path')

        # Validate path exists via Contents API
        cm = self.contents_manager
        try:
            await cm.get(path, content=False)
        except Exception as e:
            self.set_status(404)
            self.finish(json.dumps({'error': f'File not found: {path}'}))
            return

        # Get filesystem path for astropy
        os_path = cm._get_os_path(path)

        try:
            with fits.open(os_path) as hdul:
                hdus = []
                for i, hdu in enumerate(hdul):
                    hdu_info = {
                        'index': i,
                        'name': hdu.name,
                        'type': hdu.__class__.__name__,
                        'header': dict(hdu.header),
                    }
                    if hdu.data is not None:
                        hdu_info['shape'] = list(hdu.data.shape)
                        hdu_info['dtype'] = str(hdu.data.dtype)
                    else:
                        hdu_info['shape'] = None
                        hdu_info['dtype'] = None
                    hdus.append(hdu_info)

                result = {
                    'path': path,
                    'n_extensions': len(hdul),
                    'hdus': hdus
                }
                self.finish(json.dumps(result))
        except Exception as e:
            self.set_status(500)
            self.finish(json.dumps({'error': f'Error reading FITS file: {str(e)}'}))


class FITSSliceHandler(JupyterHandler):
    """Handler for retrieving data slices from FITS files.
    
    Uses JupyterHandler instead of APIHandler to support binary responses.
    
    The slices parameter uses NumPy/Python conventions:
    - Zero-indexed
    - Axis order matches NumPy (e.g., for 3D data: z,y,x or depth,row,col)
    - Half-open intervals [start, stop) with exclusive upper bound
    - Format: "start:stop,start:stop,..." for each axis
    """

    @tornado.web.authenticated
    async def get(self):
        path = self.get_argument('path')
        hdu = int(self.get_argument('hdu', 0))
        slices_str = self.get_argument('slices')  # e.g., "0:10,5:15" for 2D

        # Parse slices parameter
        try:
            slice_tuples = []
            for s in slices_str.split(','):
                parts = s.strip().split(':')
                if len(parts) != 2:
                    raise ValueError(f"Invalid slice format: '{s}'. Expected 'start:stop'.")
                start, stop = int(parts[0]), int(parts[1])
                if start < 0 or stop < 0:
                    raise ValueError(f"Negative indices not supported: '{s}'")
                if start >= stop:
                    raise ValueError(f"Start must be less than stop: '{s}'")
                slice_tuples.append((start, stop))
        except ValueError as e:
            self.set_status(400)
            self.finish(json.dumps({'error': str(e)}))
            return

        # Validate path exists via Contents API
        cm = self.contents_manager
        try:
            await cm.get(path, content=False)
        except Exception as e:
            self.set_status(404)
            self.finish(json.dumps({'error': f'File not found: {path}'}))
            return

        # Get filesystem path for astropy
        os_path = cm._get_os_path(path)

        try:
            with fits.open(os_path) as hdul:
                if hdu >= len(hdul):
                    self.set_status(400)
                    self.finish(json.dumps({
                        'error': f'HDU index {hdu} out of range (file has {len(hdul)} HDUs)'
                    }))
                    return

                data = hdul[hdu].data
                if data is None:
                    self.set_status(400)
                    self.finish(json.dumps({
                        'error': f'HDU {hdu} has no data'
                    }))
                    return

                # Validate number of slice dimensions matches data dimensions
                if len(slice_tuples) != len(data.shape):
                    self.set_status(400)
                    self.finish(json.dumps({
                        'error': f'Number of slice dimensions ({len(slice_tuples)}) does not match '
                                 f'data dimensions ({len(data.shape)}). Data shape: {list(data.shape)}'
                    }))
                    return

                # Validate slice bounds for each axis
                for axis, ((start, stop), size) in enumerate(zip(slice_tuples, data.shape)):
                    if stop > size:
                        self.set_status(400)
                        self.finish(json.dumps({
                            'error': f'Slice [{start}:{stop}] on axis {axis} out of bounds '
                                     f'for dimension size {size}. Data shape: {list(data.shape)}'
                        }))
                        return

                # Build the slice tuple and extract data
                numpy_slices = tuple(slice(start, stop) for start, stop in slice_tuples)
                slice_data = data[numpy_slices]
                
                # Get the base dtype (without byte order) and create little-endian version
                base_dtype = slice_data.dtype.newbyteorder('<')
                slice_bytes = slice_data.astype(base_dtype).tobytes()

                self.set_header('Content-Type', 'application/octet-stream')
                self.set_header('X-FITS-Shape', json.dumps(list(slice_data.shape)))
                self.set_header('X-FITS-Dtype', str(base_dtype))
                self.finish(slice_bytes)

        except Exception as e:
            self.set_status(500)
            self.finish(json.dumps({'error': f'Error reading FITS data: {str(e)}'}))


def setup_handlers(web_app):
    """Register FITS API handlers."""
    host_pattern = '.*$'
    base_url = web_app.settings['base_url']

    handlers = [
        (url_path_join(base_url, 'fitsview', 'metadata'), FITSMetadataHandler),
        (url_path_join(base_url, 'fitsview', 'slice'), FITSSliceHandler),
    ]
    web_app.add_handlers(host_pattern, handlers)
