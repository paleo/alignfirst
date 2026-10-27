export function readPackedFilename(packed) {
  // npm 11 returns an array; npm 12 returns an object keyed by package name.
  const [first] = Array.isArray(packed) ? packed : Object.values(packed ?? {});
  if (typeof first?.filename !== "string") throw new Error("npm pack returned no filename");
  return first.filename;
}
