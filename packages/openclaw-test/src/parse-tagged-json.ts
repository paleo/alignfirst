export function extractTaggedBlock(raw: string, tagName: string): string {
  const escaped = escapeRegex(tagName);
  const open = new RegExp(`<${escaped}>`).exec(raw);
  if (!open) {
    throw new Error(
      `extractTaggedBlock: opening <${tagName}> not found. raw=${JSON.stringify(raw.slice(0, 200))}`,
    );
  }
  const re = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`);
  const match = re.exec(raw);
  if (!match) {
    throw new Error(
      `extractTaggedBlock: closing </${tagName}> not found after opening tag. raw=${JSON.stringify(raw.slice(0, 200))}`,
    );
  }
  return match[1].trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
