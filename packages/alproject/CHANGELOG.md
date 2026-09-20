# @alignfirst/alproject

## 0.4.0

### Minor Changes

- 30b9db6: Moved to the `@alignfirst` npm scope. `alignfirst` itself stays unscoped, and the previous names are deprecated and receive no further releases.
  
  Replace the `@paleo/` prefix in your dependencies, then in the two scaffolded files that hardcode the scope as a path: the `include` of `./node_modules/@alignfirst/openclaw-test/docker-compose.yml` in `docker-compose.yml`, and `plugins.load.paths` under `node_modules/@alignfirst/openclaw-{discord,slack}-mock` in `openclaw.json`. A bumped dependency alone leaves `openclaw-test env up` failing on a missing Compose include, with the mock channels unloaded.

### Patch Changes

- 30b9db6: Added the `homepage` field pointing to https://alignfirst.paroi.tech, and a link to the product page in the README of each presented product.

> Versions 1.0.0 through 3.0.1 were published as `@paleo/alproject`. Those majors were a numbering
> mistake on an unfinished package. Under the `@alignfirst` scope the package restarts at 0.4.0, and
> the history below is kept as it was released.

## 3.0.1

### Patch Changes

- fa78b2f: Renamed the container concept in every message and document to "work files": the conventions line now starts with `Work files:`, `sync` reports "Work files synchronized", `doctor` shows a "Work files" section, and the team repository is called the work-files repository. The `.plans` directory, the `plans` command and the `plans` config key keep their names.

## 3.0.0

### Major Changes

- 348c407: Changed the projects marker's `portRange` to a `portRanges` array with optional codes and descriptions. Select a coded range with `free-ports --range <code>`, and repeat `init --port-range [<code>=]<first>-<last>` to declare ranges.
- 348c407: Required Node.js 24.16.0 or newer.

## 2.0.0

### Major Changes

- 44e1f9e: Breaking change: the host registry (`~/.alproject.json`, `register`, `unregister`) is replaced by markers. A project's committed `.alignfirst.json` is its registration, and `.alignfirst-projects.json` marks a projects directory. New commands: `doctor`, `init`, `free-ports`, `--guide`. Requires the `alignfirst` CLI on `PATH`.

## 1.1.0

### Minor Changes

- ecf4cee: Added explicit base-port allocations outside configured port ranges.

## 1.0.0

### Major Changes

- e44a7c8: Added detailed project status, exact base-port registration, and parent-specific port ranges using the new object-based configuration.

## 0.1.0

### Minor Changes

- 2877daa: Added the alproject CLI for project registration, discovery, and port allocation.
