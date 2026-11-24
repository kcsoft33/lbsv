/** Is version a newer than b? Plain "x.y.z" compare; pre-release/build suffixes are ignored. */
export function newer(a: string, b: string): boolean {
  const p = (v: string) => v.split(/[-+]/)[0]!.split(".").map((n) => Number(n) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
