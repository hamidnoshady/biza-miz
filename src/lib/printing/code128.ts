/** ISO/IEC 15417 Code 128 subsets B/C, for actual order/tracking references.
 * An unsupported reference stays text-only; never manufacture carrier data.
 * Each pattern is alternating bar/space widths; 10-module quiet zones.
 */
const PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212",
  "112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131",
  "311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321",
  "112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121",
  "313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114",
  "122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212",
  "124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113",
  "114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112",
];
export function code128Modules(value: string): string | null {
  if (!/^[\x20-\x7e]{1,64}$/.test(value)) return null;
  const numeric = /^(?:[0-9]{2})+$/.test(value);
  const start = numeric ? 105 : 104;
  const codes = numeric ? value.match(/../g)!.map(Number) : [...value].map(c => c.charCodeAt(0) - 32);
  const checksum = codes.reduce((sum, code, i) => sum + code * (i + 1), start) % 103;
  return "0".repeat(10) + [start, ...codes, checksum, 106].map(code =>
    [...PATTERNS[code]].map((width, i) => (i % 2 === 0 ? "1" : "0").repeat(Number(width))).join(""),
  ).join("") + "0".repeat(10);
}
export function code128Svg(value: string, availableWidthMm = 85): string | null {
  const modules = code128Modules(value);
  // Do not shrink a long reference into decorative, physically unscannable bars.
  // At least two pixels/module in the 192dpi Woo raster (0.27mm). Keep text if it cannot fit.
  if (!modules || Math.min(85, availableWidthMm) / modules.length < 0.27) return null;
  const bars = [...modules].map((v, i) => v === "1" ? `<rect x="${i}" y="0" width="1" height="55"/>` : "").join("");
  return `<svg class="bars code128" role="img" aria-label="Code 128" viewBox="0 0 ${modules.length} 55" xmlns="http://www.w3.org/2000/svg" fill="black" shape-rendering="crispEdges">${bars}</svg>`;
}
