/** Debian version ordering, as `dpkg --compare-versions` applies it:
 * epoch, then upstream version, then revision. Negative when `a` sorts
 * before `b`, zero when they are the same version, positive after. */
export function compareDebianVersions(a: string, b: string): number {
  const [epochA, upstreamA, revisionA] = split(a);
  const [epochB, upstreamB, revisionB] = split(b);
  return (
    epochA - epochB ||
    comparePart(upstreamA, upstreamB) ||
    comparePart(revisionA, revisionB)
  );
}

function split(version: string): [number, string, string] {
  const colon = version.indexOf(':');
  const epoch = colon > 0 ? Number(version.slice(0, colon)) || 0 : 0;
  const rest = colon > 0 ? version.slice(colon + 1) : version;
  const dash = rest.lastIndexOf('-');
  return dash > 0
    ? [epoch, rest.slice(0, dash), rest.slice(dash + 1)]
    : [epoch, rest, '0'];
}

/** `~` sorts before everything, even the end of the string; letters sort
 * before every other character. */
function order(char: string | undefined): number {
  if (char === undefined) return 0;
  if (char === '~') return -1;
  if (/[A-Za-z]/.test(char)) return char.charCodeAt(0);
  return char.charCodeAt(0) + 256;
}

/** Alternating runs: text, then digits, then text again, starting with text. */
function runs(part: string): string[] {
  return part
    .match(/\D*\d*/g)!
    .filter(Boolean)
    .flatMap((run) => {
      const digits = /\d*$/.exec(run)![0];
      return [run.slice(0, run.length - digits.length), digits];
    });
}

function compareText(a: string, b: string): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = order(a[i]) - order(b[i]);
    if (difference) return difference;
  }
  return 0;
}

function comparePart(a: string, b: string): number {
  const left = runs(a);
  const right = runs(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 2) {
    const difference =
      compareText(left[i] ?? '', right[i] ?? '') ||
      Number(left[i + 1] || 0) - Number(right[i + 1] || 0);
    if (difference) return difference;
  }
  return 0;
}
