// 1-bpp conversion on ImageData, in place. The printer has exactly two
// states per dot, so everything ends up through one of these before both
// preview and print — they are the same pixels by construction.

function luminance(d, i) {
  // Composite against white first: the label is white, ink is black.
  const a = d[i + 3] / 255;
  const r = d[i] * a + 255 * (1 - a);
  const g = d[i + 1] * a + 255 * (1 - a);
  const b = d[i + 2] * a + 255 * (1 - a);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function threshold(imageData, cutoff = 128) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = luminance(d, i) < cutoff ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  return imageData;
}

export function floydSteinberg(imageData, cutoff = 128) {
  const { width, height, data: d } = imageData;
  // Work on a float luminance buffer so error diffusion doesn't clip early.
  const lum = new Float32Array(width * height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) lum[p] = luminance(d, i);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const old = lum[p];
      const next = old < cutoff ? 0 : 255;
      const err = old - next;
      lum[p] = next;
      if (x + 1 < width) lum[p + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) lum[p + width - 1] += (err * 3) / 16;
        lum[p + width] += (err * 5) / 16;
        if (x + 1 < width) lum[p + width + 1] += (err * 1) / 16;
      }
    }
  }
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = lum[p] < cutoff ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  return imageData;
}
