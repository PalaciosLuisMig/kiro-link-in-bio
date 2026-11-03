// WCAG 2.x contrast ratio between two sRGB colors, used by the style tests to
// check the text (4.5:1) and focus-ring (3:1) requirements.

/** Parses `#rgb` or `#rrggbb` into 0-255 channels, or `null` if it is not a hex color. */
export function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (match === null) {
    return null;
  }
  const hex = match[1] as string;
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : hex;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Relative luminance of an sRGB color (WCAG 2.x definition). */
export function relativeLuminance([red, green, blue]: readonly [number, number, number]): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/**
 * Contrast ratio between two hex colors, from 1 (equal) to 21 (black on white).
 * Throws when a color is not a valid hex value, so a typo in the CSS fails a test.
 */
export function contrastRatio(foreground: string, background: string): number {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (fg === null || bg === null) {
    throw new Error(`Invalid hex color: ${fg === null ? foreground : background}`);
  }
  const [lighter, darker] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
}
