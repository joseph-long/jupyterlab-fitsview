import {
  DocumentModel,
  DocumentRegistry,
  DocumentWidget
} from '@jupyterlab/docregistry';
import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import { requestAPI, requestBinaryAPI, createTypedArray } from './handler';

/**
 * FITS metadata response from the server
 */
export interface IFITSMetadata {
  path: string;
  n_extensions: number;
  hdus: IHDUInfo[];
}

/**
 * Information about a single HDU
 */
export interface IHDUInfo {
  index: number;
  name: string;
  type: string;
  header: Record<string, any>;
  shape: number[] | null;
  dtype: string | null;
}

/**
 * The FITS document model - uses base DocumentModel since we don't load content
 */
export class FITSModel extends DocumentModel {
  // Uses all defaults from DocumentModel
}

/**
 * The FITS viewer panel widget
 */
export class FITSPanel extends Widget {
  constructor(context: DocumentRegistry.IContext<DocumentModel>) {
    super();
    this._context = context;
    this.addClass('jp-FITSViewer');

    // Create content container
    this._content = document.createElement('div');
    this._content.className = 'jp-FITSViewer-content';
    this.node.appendChild(this._content);

    // Load metadata when context is ready
    void context.ready.then(() => {
      void this._loadMetadata();
    });
  }

  /**
   * Load FITS metadata from the server
   */
  private async _loadMetadata(): Promise<void> {
    const path = this._context.path;
    this._content.innerHTML = `<p>Loading metadata for ${path}...</p>`;

    try {
      const metadata = await requestAPI<IFITSMetadata>(
        `metadata?path=${encodeURIComponent(path)}`
      );
      this._metadata = metadata;
      this._renderMetadata();
    } catch (error) {
      this._content.innerHTML = `<p class="jp-FITSViewer-error">Error loading FITS metadata: ${error}</p>`;
    }
  }

  /**
   * Render the metadata display
   */
  private _renderMetadata(): void {
    if (!this._metadata) {
      return;
    }

    const { path, n_extensions, hdus } = this._metadata;

    let html = `
      <h2>FITS File: ${path}</h2>
      <p><strong>Number of HDUs:</strong> ${n_extensions}</p>
      <hr/>
    `;

    for (const hdu of hdus) {
      html += `
        <div class="jp-FITSViewer-hdu">
          <h3>HDU ${hdu.index}: ${hdu.name || '(unnamed)'}</h3>
          <p><strong>Type:</strong> ${hdu.type}</p>
      `;

      if (hdu.shape) {
        html += `
          <p><strong>Shape:</strong> ${hdu.shape.join(' × ')}</p>
          <p><strong>Data type:</strong> ${hdu.dtype}</p>
        `;

        // Add a test slice button for any data with shape
        if (hdu.shape.length >= 1) {
          // Build slice ranges for each axis, taking min(10, axis_size) for each
          const sliceRanges = hdu.shape.map(size => `0:${Math.min(10, size)}`);
          const slicesStr = sliceRanges.join(',');
          const displayShape = hdu.shape.map(size => Math.min(10, size)).join(' × ');
          html += `
            <button class="jp-FITSViewer-sliceButton" 
                    data-hdu="${hdu.index}" 
                    data-slices="${slicesStr}">
              Test slice [${slicesStr}] (${displayShape})
            </button>
            <pre class="jp-FITSViewer-sliceResult" id="slice-result-${hdu.index}"></pre>
          `;
        }
      } else {
        html += `<p><em>No data in this HDU</em></p>`;
      }

      // Show selected header keywords
      const importantKeys = ['BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'BSCALE', 'BZERO', 'OBJECT', 'DATE-OBS'];
      const headerEntries = Object.entries(hdu.header)
        .filter(([k]) => importantKeys.includes(k) || k.startsWith('COMMENT') === false && k.startsWith('HISTORY') === false)
        .slice(0, 20);

      if (headerEntries.length > 0) {
        html += `<details><summary>Header (first 20 keywords)</summary><table class="jp-FITSViewer-headerTable">`;
        for (const [key, value] of headerEntries) {
          html += `<tr><td><code>${key}</code></td><td>${value}</td></tr>`;
        }
        html += `</table></details>`;
      }

      html += `</div>`;
    }

    this._content.innerHTML = html;

    // Attach event listeners to slice buttons
    const buttons = this._content.querySelectorAll('.jp-FITSViewer-sliceButton');
    buttons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const hdu = parseInt(target.dataset.hdu || '0', 10);
        const slices = target.dataset.slices || '0:10,0:10';
        void this._fetchSlice(hdu, slices);
      });
    });
  }

  /**
   * Fetch a data slice from the server
   * 
   * @param hdu - HDU index
   * @param slices - Comma-separated slice ranges in NumPy format (e.g., "0:10,5:15")
   */
  private async _fetchSlice(
    hdu: number,
    slices: string
  ): Promise<void> {
    const resultEl = document.getElementById(`slice-result-${hdu}`);
    if (resultEl) {
      resultEl.textContent = 'Loading slice...';
    }

    try {
      const path = this._context.path;
      const { buffer, shape, dtype } = await requestBinaryAPI(
        `slice?path=${encodeURIComponent(path)}&hdu=${hdu}&slices=${encodeURIComponent(slices)}`
      );

      // Convert to appropriate TypedArray based on dtype
      const data = createTypedArray(buffer, dtype);

      if (resultEl) {
        let output = `Shape: ${shape.join(' × ')}\n`;
        output += `Dtype: ${dtype}\n`;
        output += `Total elements: ${data.length}\n`;
        output += `Sample values (first 25):\n`;

        // Check if it's a BigInt array
        const isBigInt =
          data instanceof BigInt64Array || data instanceof BigUint64Array;

        // Display as 2D grid if possible
        const displayH = Math.min(5, shape[shape.length - 2] || 1);
        const displayW = Math.min(5, shape[shape.length - 1] || data.length);

        for (let row = 0; row < displayH; row++) {
          const rowValues: string[] = [];
          for (let col = 0; col < displayW; col++) {
            const idx = row * (shape[shape.length - 1] || displayW) + col;
            if (idx < data.length) {
              if (isBigInt) {
                rowValues.push(data[idx].toString());
              } else {
                rowValues.push((data[idx] as number).toFixed(2));
              }
            }
          }
          output += rowValues.join('\t') + '\n';
        }

        resultEl.textContent = output;
      }
    } catch (error) {
      if (resultEl) {
        resultEl.textContent = `Error: ${error}`;
      }
    }
  }

  /**
   * Handle dispose
   */
  protected onCloseRequest(msg: Message): void {
    super.onCloseRequest(msg);
    this.dispose();
  }

  private _context: DocumentRegistry.IContext<DocumentModel>;
  private _content: HTMLDivElement;
  private _metadata: IFITSMetadata | null = null;
}

/**
 * A document widget for FITS files
 */
export class FITSDocument extends DocumentWidget<FITSPanel, DocumentModel> {
  constructor(options: DocumentWidget.IOptions<FITSPanel, DocumentModel>) {
    super(options);
  }
}
