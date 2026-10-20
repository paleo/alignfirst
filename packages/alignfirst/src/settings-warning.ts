export function warnUnknownSetting(
  file: string,
  path: string,
  key: string,
  hint = "Remove it or check its spelling.",
): void {
  const quoted = JSON.stringify(key).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
  const field = /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${path === "" ? "" : `${path}.`}${key}`
    : `${path === "" ? "settings" : path}[${quoted}]`;
  console.warn(`Warning: ignoring unknown ${file} setting ${field}. ${hint}`);
}
