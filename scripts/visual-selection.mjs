/** Select a reviewed local capture without changing the default/full CI gate.
 * @param {string[]} ids
 * @param {string[]} args
 * @param {boolean} ci
 */
export function selectVisualScreens(ids, args, ci) {
  const flags = args.filter((arg) => arg.startsWith("--screens="));
  if (args.some((arg) => arg !== "--update" && !arg.startsWith("--screens="))) {
    throw new Error("Unknown visual option; use --update and/or --screens=id,id");
  }
  if (!flags.length) return ids;
  if (ci) throw new Error("CI must compare the complete visual suite; --screens is local-only");
  if (flags.length !== 1) throw new Error("Specify --screens once");
  const selected = flags[0].slice("--screens=".length).split(",");
  if (selected.some((id) => !ids.includes(id))) throw new Error("Unknown or empty visual screen id");
  return ids.filter((id) => selected.includes(id));
}
