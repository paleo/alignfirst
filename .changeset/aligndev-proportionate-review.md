---
"aligndev": patch
---

Made the assistant's own code review proportionate: the playbook skips it for a small, low-risk change, limits it to the commits added since the branch's last review, names the review form when it knows more than the diff shows, and runs the recheck only after an Important fix or a fix that went beyond the findings.
