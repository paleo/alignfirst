export const CMD_PLACEHOLDER = "{{CMD}}";

export function renderCommandForm(text: string, form: string): string {
  return text.replaceAll(CMD_PLACEHOLDER, () => form);
}
