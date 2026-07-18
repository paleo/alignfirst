import { en } from "./en.js";
import { fr } from "./fr.js";
import type { SearchLocale } from "./locale.js";

// Registry order matters: the first locale whose foldPlural changes a word wins.
export const locales: SearchLocale[] = [en, fr];
