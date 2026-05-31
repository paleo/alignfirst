export interface SelectedModel {
  /** Bare id: the suffix after the last `/` of the full ref. */
  id: string;
  /** Full LiteLLM `provider/model` ref, as written in `OPENCLAW_TEST_MODELS`. */
  ref: string;
}

/**
 * Resolve the `--model` value against the configured model catalog.
 *
 * `OPENCLAW_TEST_MODELS` is a comma list of full `provider/model` refs — the only
 * place the `provider/` prefix appears. The CLI value, `OPENCLAW_DEFAULT_TEST_MODEL`,
 * and the recorded `model` are all bare ids (the suffix after the last `/`). A bare
 * id resolves to its ref by suffix-match; zero or many matches is a hard error.
 *
 * The selection is `all` (whole catalog), a single bare id, or a comma list of bare
 * ids (deduped, order preserved); `undefined` falls back to `OPENCLAW_DEFAULT_TEST_MODEL`.
 */
export function resolveSelectedModels(params: {
  selection: string | undefined;
  modelsEnv: string | undefined;
  defaultEnv: string | undefined;
}): SelectedModel[] {
  const catalog = parseCatalog(params.modelsEnv);
  if (params.selection === "all") return catalog;
  if (params.selection !== undefined) return resolveIdList(catalog, params.selection);
  if (!params.defaultEnv) {
    throw new Error(
      "run: no --model given and OPENCLAW_DEFAULT_TEST_MODEL is unset; pass --model <id|id,id,…|all> or set the default",
    );
  }
  return [matchById(catalog, params.defaultEnv)];
}

function resolveIdList(catalog: SelectedModel[], selection: string): SelectedModel[] {
  const ids = selection
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error(`run: --model expects a non-empty id list, got ${JSON.stringify(selection)}`);
  }
  const seen = new Set<string>();
  const selected: SelectedModel[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(matchById(catalog, id));
  }
  return selected;
}

function parseCatalog(modelsEnv: string | undefined): SelectedModel[] {
  const refs = (modelsEnv ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (refs.length === 0) {
    throw new Error("run: OPENCLAW_TEST_MODELS is empty; set a comma list of provider/model refs");
  }
  const catalog = refs.map((ref) => ({ id: bareId(ref), ref }));
  assertUniqueIds(catalog);
  return catalog;
}

function bareId(ref: string): string {
  const id = ref.split("/").pop();
  if (!id) throw new Error(`run: invalid model ref ${JSON.stringify(ref)} in OPENCLAW_TEST_MODELS`);
  return id;
}

function assertUniqueIds(catalog: SelectedModel[]): void {
  const seen = new Set<string>();
  for (const { id } of catalog) {
    if (seen.has(id)) {
      throw new Error(
        `run: OPENCLAW_TEST_MODELS has two entries with bare id ${JSON.stringify(id)}`,
      );
    }
    seen.add(id);
  }
}

function matchById(catalog: SelectedModel[], id: string): SelectedModel {
  const matches = catalog.filter((m) => m.id === id);
  if (matches.length === 1) return matches[0];
  const known = catalog.map((m) => m.id).join(", ");
  if (matches.length === 0) {
    throw new Error(
      `run: model ${JSON.stringify(id)} not found in OPENCLAW_TEST_MODELS — known: ${known}`,
    );
  }
  throw new Error(
    `run: model ${JSON.stringify(id)} is ambiguous in OPENCLAW_TEST_MODELS — known: ${known}`,
  );
}
