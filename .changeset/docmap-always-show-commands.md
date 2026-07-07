---
"@paleo/docmap": patch
---

A bare `docmap` now always prints the command list, even for large doc trees. Previously the command list appeared only on projects with fewer than 20 documents, hiding it from exactly the larger projects where navigating with the CLI matters most.
