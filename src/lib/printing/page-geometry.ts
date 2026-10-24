/** Server-resolved physical page geometry for silent Windows driver printing. */
export interface PageGeometry { widthMm: number; heightMm: number; }
export function validPageGeometry(value: unknown): value is PageGeometry {
  if (!value || typeof value !== "object") return false;
  const g = value as PageGeometry;
  return Number.isFinite(g.widthMm) && Number.isFinite(g.heightMm) && g.widthMm >= 25 && g.widthMm <= 500 && g.heightMm >= 25 && g.heightMm <= 500;
}
