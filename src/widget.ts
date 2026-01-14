import {
  DocumentModel,
  DocumentRegistry,
  DocumentWidget
} from '@jupyterlab/docregistry';
import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import {
  requestAPI,
  requestBinaryAPI,
  requestBinaryAPIWithProgress,
  createTypedArray,
  ArrayType,
  calculateSliceByteSize,
  formatByteSize
} from './handler';

// Maximum auto-fetch size in bytes (5 MB)
const MAX_AUTO_FETCH_SIZE = 5 * 1024 * 1024;

// Dynamically import viewarr for WASM viewer
// Using dynamic import allows graceful degradation if viewarr isn't built
let viewarr: typeof import('viewarr') | null = null;
const viewarrPromise = import('viewarr')
  .then(module => {
    viewarr = module;
  })
  .catch(err => {
    console.warn('viewarr module not available, image viewer disabled:', err);
  });

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
  header: string;  // Raw 80-column FITS header string
  shape: number[] | null;
  arrayType: ArrayType | null;
}

/**
 * The FITS document model - uses base DocumentModel since we don't load content
 */
export class FITSModel extends DocumentModel {
  // Uses all defaults from DocumentModel
}

/**
 * State for slice navigation on a single HDU
 */
interface ISliceState {
  hduIndex: number;
  shape: number[];
  // Current index for each leading axis (all but last 2)
  sliceIndices: number[];
}

/**
 * The FITS viewer panel widget
 */
export class FITSPanel extends Widget {
  private static _instanceCounter = 0;
  private _viewerId: string;
  private _viewerContainer: HTMLDivElement | null = null;
  private _sliceState: ISliceState | null = null;
  private _sliceControlsContainer: HTMLDivElement | null = null;
  private _fetchAbortController: AbortController | null = null;

  constructor(context: DocumentRegistry.IContext<DocumentModel>) {
    super();
    this._context = context;
    this.addClass('jp-FITSViewer');

    // Generate unique viewer ID
    this._viewerId = `fitsview-${FITSPanel._instanceCounter++}`;

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

    // Create main layout with viewer panel and metadata panel
    let html = `
      <div class="jp-FITSViewer-layout">
        <div class="jp-FITSViewer-viewerPanel">
          <div id="${this._viewerId}-controls" class="jp-FITSViewer-sliceControls"></div>
          <div id="${this._viewerId}" class="jp-FITSViewer-viewerContainer">
            <div class="jp-FITSViewer-viewerPlaceholder">Select an HDU to view</div>
          </div>
        </div>
        <div class="jp-FITSViewer-metadataPanel">
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
          <p><strong>Array type:</strong> ${hdu.arrayType}</p>
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

      // Show header as raw 80-column FITS format (monospace)
      if (hdu.header) {
        // Escape HTML entities in the header string
        const escapedHeader = String(hdu.header)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        html += `<details><summary>Header</summary><pre class="jp-FITSViewer-headerPre">${escapedHeader}</pre></details>`;
      }

      html += `</div>`;
    }

    html += `
        </div>
      </div>
    `;

    this._content.innerHTML = html;

    // Store references to containers
    this._viewerContainer = document.getElementById(this._viewerId) as HTMLDivElement;
    this._sliceControlsContainer = document.getElementById(`${this._viewerId}-controls`) as HTMLDivElement;

    // Initialize the viewer and then auto-display first viewable HDU
    void this._initializeViewer().then(() => {
      this._autoDisplayFirstHDU();
    });

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
   * Initialize the viewarr WASM viewer
   */
  private async _initializeViewer(): Promise<void> {
    await viewarrPromise;

    if (!viewarr || !this._viewerContainer) {
      return;
    }

    try {
      await viewarr.createViewer(this._viewerId);
    } catch (error) {
      console.error('Failed to initialize viewarr:', error);
    }
  }

  /**
   * Automatically display the first HDU with viewable 2D+ data
   */
  private _autoDisplayFirstHDU(): void {
    if (!this._metadata || !viewarr || !viewarr.hasViewer(this._viewerId)) {
      return;
    }

    // Find first HDU with 2D+ data
    const viewableHDU = this._metadata.hdus.find(
      hdu => hdu.shape && hdu.shape.length >= 2 && hdu.arrayType
    );

    if (viewableHDU) {
      void this._viewHDUImage(viewableHDU.index);
    }
  }

  /**
   * View full HDU image in the viewer
   */
  private async _viewHDUImage(hduIndex: number): Promise<void> {
    if (!viewarr || !viewarr.hasViewer(this._viewerId)) {
      console.warn('Viewer not available');
      return;
    }

    const hdu = this._metadata?.hdus.find(h => h.index === hduIndex);
    if (!hdu || !hdu.shape || hdu.shape.length < 2 || !hdu.arrayType) {
      return;
    }

    const shape = hdu.shape;
    const numLeadingAxes = shape.length - 2;

    // Initialize or update slice state
    if (!this._sliceState || this._sliceState.hduIndex !== hduIndex) {
      this._sliceState = {
        hduIndex,
        shape,
        sliceIndices: new Array(numLeadingAxes).fill(0)
      };
    }

    // Render slice controls if we have leading axes
    this._renderSliceControls();

    // Calculate the byte size for the 2D slice
    const sliceByteSize = calculateSliceByteSize(shape, hdu.arrayType);

    if (sliceByteSize <= MAX_AUTO_FETCH_SIZE) {
      // Small enough to auto-fetch
      await this._fetchAndDisplaySlice();
    } else {
      // Too large - show fetch prompt
      this._showLargeImagePrompt(sliceByteSize);
    }
  }

  /**
   * Show a prompt for large images with fetch button and progress UI
   */
  private _showLargeImagePrompt(byteSize: number): void {
    if (!this._viewerContainer) {
      return;
    }

    const sizeStr = formatByteSize(byteSize);
    this._viewerContainer.innerHTML = `
      <div class="jp-FITSViewer-largeImagePrompt">
        <p>This image slice is <strong>${sizeStr}</strong>, which exceeds the auto-fetch limit.</p>
        <button class="jp-FITSViewer-fetchButton jp-mod-styled">
          Fetch and Display
        </button>
        <div class="jp-FITSViewer-progressContainer" style="display: none;">
          <div class="jp-FITSViewer-progressBar">
            <div class="jp-FITSViewer-progressFill"></div>
          </div>
          <span class="jp-FITSViewer-progressText">0%</span>
          <button class="jp-FITSViewer-cancelButton jp-mod-styled jp-mod-warn">
            Cancel
          </button>
        </div>
      </div>
    `;

    const fetchButton = this._viewerContainer.querySelector('.jp-FITSViewer-fetchButton') as HTMLButtonElement;
    const progressContainer = this._viewerContainer.querySelector('.jp-FITSViewer-progressContainer') as HTMLDivElement;
    const progressFill = this._viewerContainer.querySelector('.jp-FITSViewer-progressFill') as HTMLDivElement;
    const progressText = this._viewerContainer.querySelector('.jp-FITSViewer-progressText') as HTMLSpanElement;
    const cancelButton = this._viewerContainer.querySelector('.jp-FITSViewer-cancelButton') as HTMLButtonElement;

    fetchButton.addEventListener('click', () => {
      fetchButton.style.display = 'none';
      progressContainer.style.display = 'flex';
      void this._fetchAndDisplaySliceWithProgress(progressFill, progressText, progressContainer);
    });

    cancelButton.addEventListener('click', () => {
      if (this._fetchAbortController) {
        this._fetchAbortController.abort();
        this._fetchAbortController = null;
      }
      // Reset UI
      fetchButton.style.display = 'block';
      progressContainer.style.display = 'none';
      progressFill.style.width = '0%';
      progressText.textContent = '0%';
    });
  }

  /**
   * Fetch and display slice with progress tracking
   */
  private async _fetchAndDisplaySliceWithProgress(
    progressFill: HTMLDivElement,
    progressText: HTMLSpanElement,
    progressContainer: HTMLDivElement
  ): Promise<void> {
    if (!this._sliceState || !viewarr || !viewarr.hasViewer(this._viewerId)) {
      return;
    }

    const { hduIndex, shape, sliceIndices } = this._sliceState;

    // Build slice string
    const slices = shape.map((size, i) => {
      if (i < shape.length - 2) {
        const idx = sliceIndices[i];
        return `${idx}:${idx + 1}`;
      }
      return `0:${size}`;
    }).join(',');

    // Create abort controller
    this._fetchAbortController = new AbortController();

    try {
      const path = this._context.path;
      const { buffer, shape: resultShape, arrayType } = await requestBinaryAPIWithProgress(
        `slice?path=${encodeURIComponent(path)}&hdu=${hduIndex}&slices=${encodeURIComponent(slices)}`,
        (loaded, total) => {
          const percent = Math.round((loaded / total) * 100);
          progressFill.style.width = `${percent}%`;
          progressText.textContent = `${percent}% (${formatByteSize(loaded)} / ${formatByteSize(total)})`;
        },
        this._fetchAbortController.signal
      );

      this._fetchAbortController = null;

      // Get image dimensions
      const height = resultShape[resultShape.length - 2] || 1;
      const width = resultShape[resultShape.length - 1] || 1;

      // Clear the prompt and show image
      if (this._viewerContainer) {
        this._viewerContainer.innerHTML = '';
        // Recreate the canvas - viewer needs to be reinitialized
        await viewarr.createViewer(this._viewerId);
      }

      viewarr.setImageData(this._viewerId, buffer, width, height, arrayType);
    } catch (error) {
      this._fetchAbortController = null;
      if ((error as Error).name === 'AbortError') {
        console.log('Fetch cancelled by user');
        return;
      }
      console.error('Failed to load slice:', error);
      progressContainer.innerHTML = `<span class="jp-FITSViewer-error">Error: ${error}</span>`;
    }
  }

  /**
   * Render slice navigation controls for leading axes
   */
  private _renderSliceControls(): void {
    if (!this._sliceControlsContainer || !this._sliceState) {
      return;
    }

    const { shape, sliceIndices } = this._sliceState;
    const numLeadingAxes = shape.length - 2;

    if (numLeadingAxes === 0) {
      // No leading axes, hide controls
      this._sliceControlsContainer.innerHTML = '';
      return;
    }

    let html = '';
    for (let axis = 0; axis < numLeadingAxes; axis++) {
      const axisSize = shape[axis];
      const currentIndex = sliceIndices[axis];
      const axisLabel = numLeadingAxes === 1 ? 'Plane' : `Axis ${axis}`;

      html += `
        <div class="jp-FITSViewer-sliceControl" data-axis="${axis}">
          <button class="jp-FITSViewer-sliceButton jp-FITSViewer-prevButton"
                  data-axis="${axis}"
                  data-direction="prev"
                  ${currentIndex === 0 ? 'disabled' : ''}>
            ◀
          </button>
          <span class="jp-FITSViewer-sliceLabel">
            ${axisLabel}: <strong>${currentIndex + 1}</strong> / ${axisSize}
          </span>
          <button class="jp-FITSViewer-sliceButton jp-FITSViewer-nextButton"
                  data-axis="${axis}"
                  data-direction="next"
                  ${currentIndex >= axisSize - 1 ? 'disabled' : ''}>
            ▶
          </button>
        </div>
      `;
    }

    this._sliceControlsContainer.innerHTML = html;

    // Attach event listeners
    const buttons = this._sliceControlsContainer.querySelectorAll('.jp-FITSViewer-sliceButton');
    buttons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const axis = parseInt(target.dataset.axis || '0', 10);
        const direction = target.dataset.direction;
        this._navigateSlice(axis, direction === 'next' ? 1 : -1);
      });
    });
  }

  /**
   * Navigate to a different slice along a given axis
   */
  private _navigateSlice(axis: number, delta: number): void {
    if (!this._sliceState) {
      return;
    }

    const { shape, sliceIndices } = this._sliceState;
    const axisSize = shape[axis];
    const newIndex = Math.max(0, Math.min(axisSize - 1, sliceIndices[axis] + delta));

    if (newIndex !== sliceIndices[axis]) {
      this._sliceState.sliceIndices[axis] = newIndex;
      this._renderSliceControls();
      void this._fetchAndDisplaySlice();
    }
  }

  /**
   * Fetch and display the current slice based on slice state
   */
  private async _fetchAndDisplaySlice(): Promise<void> {
    if (!this._sliceState || !viewarr || !viewarr.hasViewer(this._viewerId)) {
      return;
    }

    const { hduIndex, shape, sliceIndices } = this._sliceState;

    // Build slice string: for leading axes use current index, for image axes use full extent
    const slices = shape.map((size, i) => {
      if (i < shape.length - 2) {
        const idx = sliceIndices[i];
        return `${idx}:${idx + 1}`;
      }
      return `0:${size}`;
    }).join(',');

    try {
      const path = this._context.path;
      const { buffer, shape: resultShape, arrayType } = await requestBinaryAPI(
        `slice?path=${encodeURIComponent(path)}&hdu=${hduIndex}&slices=${encodeURIComponent(slices)}`
      );

      // Get image dimensions (last two elements of shape)
      const height = resultShape[resultShape.length - 2] || 1;
      const width = resultShape[resultShape.length - 1] || 1;

      // Use arrayType from response for proper data interpretation
      viewarr.setImageData(this._viewerId, buffer, width, height, arrayType);
    } catch (error) {
      console.error('Failed to load slice:', error);
    }
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
      const { buffer, shape, arrayType } = await requestBinaryAPI(
        `slice?path=${encodeURIComponent(path)}&hdu=${hdu}&slices=${encodeURIComponent(slices)}`
      );

      // Convert to appropriate TypedArray based on arrayType
      const data = createTypedArray(buffer, arrayType);

      if (resultEl) {
        let output = `Shape: ${shape.join(' × ')}\n`;
        output += `Type: ${arrayType}\n`;
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
    // Clean up viewarr instance
    if (viewarr && viewarr.hasViewer(this._viewerId)) {
      viewarr.destroyViewer(this._viewerId);
    }
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
