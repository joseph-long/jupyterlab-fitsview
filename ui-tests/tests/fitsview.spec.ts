import { expect, test } from '@jupyterlab/galata';

/**
 * Note: These tests require a test.fits file to be present.
 * The test file should be created before running tests.
 */

test.describe('FITS Viewer Extension', () => {
  test.beforeEach(async ({ page }) => {
    // Create a test FITS file using Python
    await page.menu.clickMenuItem('File>New>Notebook');
    await page.getByRole('button', { name: 'Select' }).click();

    await page.notebook.setCell(
      0,
      'code',
      `from astropy.io import fits
import numpy as np

# Create a simple test FITS file
data = np.random.random((50, 50)).astype(np.float32)
hdu = fits.PrimaryHDU(data)
hdu.header['OBJECT'] = 'Test Object'
hdul = fits.HDUList([hdu])
hdul.writeto('test.fits', overwrite=True)
print('Created test.fits')`
    );

    await page.notebook.run();
    await page.waitForTimeout(500);

    // Close the notebook
    await page.menu.clickMenuItem('File>Close Tab');
    await page.getByRole('button', { name: "Don't Save" }).click();
  });

  test('should open FITS file in viewer', async ({ page }) => {
    // Open the FITS file from file browser
    await page.filebrowser.open('test.fits');

    // Wait for the FITS viewer to load
    const viewer = page.getByRole('main').locator('.jp-FITSViewer');
    await expect(viewer).toBeVisible();

    // Check that metadata is displayed
    await expect(viewer.locator('h2')).toContainText('FITS File');
    await expect(viewer.locator('text=PRIMARY')).toBeVisible();
  });

  test('should display HDU information', async ({ page }) => {
    await page.filebrowser.open('test.fits');

    const viewer = page.getByRole('main').locator('.jp-FITSViewer');
    await expect(viewer).toBeVisible();

    // Check HDU info is shown
    await expect(viewer.locator('text=PrimaryHDU')).toBeVisible();
    await expect(viewer.locator('text=Shape')).toBeVisible();
    await expect(viewer.locator('text=50 × 50')).toBeVisible();
  });

  test('should fetch data slice', async ({ page }) => {
    await page.filebrowser.open('test.fits');

    const viewer = page.getByRole('main').locator('.jp-FITSViewer');
    await expect(viewer).toBeVisible();

    // Click the test slice button
    const sliceButton = viewer.locator('.jp-FITSViewer-sliceButton').first();
    await sliceButton.click();

    // Wait for slice result to appear
    const sliceResult = viewer.locator('.jp-FITSViewer-sliceResult').first();
    await expect(sliceResult).toContainText('Shape:');
    await expect(sliceResult).toContainText('Total elements:');
  });
});
