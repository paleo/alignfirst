## Projects and directory structure

Every project is a direct child of `{{PROJECTS_ROOT}}`. The managed port range is `{{PORT_RANGE_FIRST}}..{{PORT_RANGE_LAST}}`. Adding a project is an operator's decision: ask before creating or registering one.

<!-- TEAM_PLANS_SECTION -->
A clone of the team plans repository may sit under the parent. It is a repository, not a project: it stays unregistered, with no ports and no workspace.
<!-- TEAM_PLANS_SECTION -->

<!-- Operator: to split projects into several parents, add `projectParents` entries to `.alproject.json` (each optionally with its own sub-range) and describe them here. -->
